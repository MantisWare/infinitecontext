// =============================================================================
// UPDATE MESSAGES — patch messages in a context, creating a new version head
// Ported from PATCH /contexts/:id in apps/api routes. Copy-on-write semantics.
// =============================================================================

import type { StorageAdapter } from '../storage';
import { findHead, getOrderedNodes, getVersions } from '../context-chain';
import { resolveMessagePublicId } from '../message-target';
import { stampMetadataClientNodeId } from '../ic-client-node-id';
import { resolveUpdateSelectorsToClientNodeIds } from '../message-sync-targets';
import { generatePublicId } from '../public-ids';
import { isPlainObject, parseUpdateRequestBody } from '../request-parsing';
import type { MessageView } from '../message-view';
import { ok, err, type Result } from '../result';
import { UPDATE_RETRY_ATTEMPTS, updateErrorCode } from './update-errors';

// -- rollback helper ----------------------------------------------------------
// Best-effort cleanup of an orphaned version head and its children, swallowing
// any rollback errors (mirrors the route's rollbackHead).

async function rollbackHead(storage: StorageAdapter, projectId: number, headId: string) {
    try {
        await storage.deleteNodesByContextId(projectId, headId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for children of head ${headId}: ${message}`);
    }

    try {
        await storage.deleteNodeByPublicId(projectId, headId);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Rollback failed for head ${headId}: ${message}`);
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type UpdateSuccess = { data: MessageView[]; version: number; affected_client_ids: string[] };
type UpdateOutcome =
    | UpdateSuccess
    | { code: 'not_found' | 'internal' | 'invalid_input' | 'conflict'; message: string };

async function updateMessagesOnce(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    body: object,
): Promise<UpdateOutcome> {
    const parsed = parseUpdateRequestBody(body);
    if ('error' in parsed) return { code: 'invalid_input', message: parsed.error };

    const { userMetadata, updates } = parsed;

    for (const u of updates) {
        if (!isPlainObject(u)) return { code: 'invalid_input', message: 'Each update must be an object' };
        const hasId = u.id !== undefined;
        const hasIndex = u.index !== undefined;
        if (hasId && hasIndex) return { code: 'invalid_input', message: 'Cannot specify both id and index' };
        if (!hasId && !hasIndex) return { code: 'invalid_input', message: 'Either id or index required' };
        if (hasId && typeof u.id !== 'string') return { code: 'invalid_input', message: 'id must be a string' };
        if (hasIndex && (typeof u.index !== 'number' || !Number.isInteger(u.index))) {
            return { code: 'invalid_input', message: 'index must be an integer' };
        }
    }

    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return { code: 'not_found', message: 'Context not found' };

    await storage.lockRootContextForUpdate(projectId, root.public_id);

    const currentHead = await findHead(storage, root.public_id);
    if (!currentHead) return { code: 'internal', message: 'HEAD not found' };

    const orderedNodes = await getOrderedNodes(storage, currentHead.public_id);

    const affectedResolved = resolveUpdateSelectorsToClientNodeIds(orderedNodes, updates);
    if (!affectedResolved.ok) return { code: affectedResolved.code, message: affectedResolved.message };
    const affectedClientIds = affectedResolved.data;

    const resolvedUpdates: Array<{ id: string; [key: string]: unknown }> = [];
    for (const u of updates) {
        const selector = u.id !== undefined ? u.id : u.index!;
        const resolved = resolveMessagePublicId(orderedNodes, selector as string | number);
        if ('code' in resolved) return { code: resolved.code, message: resolved.message };
        const { index: _idx, id: _id, ...rest } = u;
        resolvedUpdates.push({ ...rest, id: resolved.publicId });
    }

    const updateMap = new Map(resolvedUpdates.map((u) => [u.id, u]));
    const affectedIds = resolvedUpdates.map((u) => u.id);

    const newHeadId = generatePublicId('context');
    try {
        await storage.insertNodes({
            public_id: newHeadId,
            project_id: projectId,
            type: 'context',
            context_id: root.public_id,
            prev_id: currentHead.public_id,
            content: {},
            metadata: { operation: 'update', affected: affectedIds, ...(userMetadata ?? {}) },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create version head';
        return { code: 'internal', message };
    }

    const isEncryptedEnvelope = (value: Record<string, unknown>) =>
        value.__ic_enc === 1 && typeof value.kid === 'string';

    const envelopeOnly = (value: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const key of ['__ic_enc', 'kid', 'v', 'alg', 'nonce', 'ct'] as const) {
            if (value[key] !== undefined) out[key] = value[key];
        }
        return out;
    };

    const newNodes = orderedNodes.map((n) => {
        const update = updateMap.get(n.public_id);
        const {
            id: _writeId,
            index: _writeIndex,
            metadata: updateMetadata,
            ...contentChanges
        } = (update ?? {}) as {
            id?: string;
            index?: number;
            metadata?: Record<string, unknown>;
            [key: string]: unknown;
        };
        let content = n.content as Record<string, unknown>;
        let metadata = n.metadata as Record<string, unknown>;
        if (update) {
            if (Object.keys(contentChanges).length > 0) {
                content = isEncryptedEnvelope(contentChanges)
                    ? envelopeOnly(contentChanges)
                    : { ...content, ...contentChanges };
            }
            if (updateMetadata !== undefined && typeof updateMetadata === 'object' && !Array.isArray(updateMetadata)) {
                metadata = updateMetadata as Record<string, unknown>;
            }
        }
        return {
            public_id: generatePublicId('msg'),
            project_id: projectId,
            type: 'message',
            context_id: newHeadId,
            parent_id: n.public_id,
            prev_id: null as string | null,
            content,
            metadata: stampMetadataClientNodeId(n.public_id, metadata),
        };
    });

    for (let i = 1; i < newNodes.length; i++) {
        newNodes[i].prev_id = newNodes[i - 1].public_id;
    }

    try {
        await storage.insertNodes(newNodes);
    } catch {
        await rollbackHead(storage, projectId, newHeadId);
        return { code: 'internal', message: 'Failed to update messages' };
    }

    const versions = await getVersions(storage, root.public_id);
    const currentVersion = versions.length - 1;

    const result: MessageView[] = newNodes.map((n, index: number) => ({
        ...n.content,
        id: n.public_id,
        index,
        metadata: n.metadata,
    }));

    return { data: result, version: currentVersion, affected_client_ids: affectedClientIds };
}

// -- op -----------------------------------------------------------------------

export async function updateMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    body: object,
    options?: { inTransaction?: boolean },
): Promise<Result<UpdateSuccess>> {
    const runInTx = async (tx: StorageAdapter) => updateMessagesOnce(tx, projectId, contextId, body);

    if (options?.inTransaction) {
        const outcome = await runInTx(storage);
        if ('code' in outcome) return err(outcome.code, outcome.message);
        return ok(outcome);
    }

    for (let attempt = 0; attempt < UPDATE_RETRY_ATTEMPTS; attempt += 1) {
        try {
            const outcome = await storage.transaction<UpdateOutcome>(
                async (tx) => runInTx(tx),
                { isolationLevel: 'serializable' },
            );
            if ('code' in outcome) return err(outcome.code, outcome.message);
            return ok(outcome);
        } catch (error) {
            if (updateErrorCode(error) === 'conflict') {
                await sleep(5 * (attempt + 1));
                continue;
            }
            return err('internal', 'Failed to update messages');
        }
    }

    return err('conflict', 'Concurrent update retries exhausted; retry the request');
}
