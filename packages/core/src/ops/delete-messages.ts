// =============================================================================
// DELETE MESSAGES — remove messages from a context by id or index
// (ported from the DELETE /contexts/:id message-delete path)
// =============================================================================

import { findHead, getOrderedNodes, getVersions } from '../context-chain';
import { resolveMessagePublicId } from '../message-target';
import { stampMetadataClientNodeId } from '../ic-client-node-id';
import { resolveSelectorsToClientNodeIds } from '../message-sync-targets';
import { generatePublicId } from '../public-ids';
import { isPlainObject } from '../request-parsing';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';
import { UPDATE_RETRY_ATTEMPTS, updateErrorCode } from './update-errors';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// -- params -------------------------------------------------------------------

export type DeleteMessagesParams = {
    ids: (string | number)[];
    userMetadata?: Record<string, unknown>;
};

// -- rollback helper ----------------------------------------------------------
// Drop an orphaned version head (and any children) after a failed copy step.

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

// -- op -----------------------------------------------------------------------

type DeleteSuccess = { data: MessageView[]; version: number; deleted_client_ids: string[] };
type DeleteOutcome =
    | DeleteSuccess
    | { code: 'not_found' | 'internal' | 'invalid_input' | 'conflict'; message: string };

async function deleteMessagesOnce(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    params: DeleteMessagesParams,
): Promise<DeleteOutcome> {
    const { ids, userMetadata } = params;

    if (userMetadata !== undefined && !isPlainObject(userMetadata)) {
        return { code: 'invalid_input', message: 'metadata must be an object' };
    }

    if (ids === undefined || ids === null) return { code: 'invalid_input', message: 'ids is required' };

    const rawIds: Array<string | number> = Array.isArray(ids) ? ids : [ids];
    if (rawIds.length === 0) return { code: 'invalid_input', message: 'ids must be a non-empty array' };

    for (const input of rawIds) {
        if (typeof input === 'string') continue;
        if (typeof input !== 'number' || !Number.isInteger(input)) {
            return { code: 'invalid_input', message: 'Each id must be a string or integer index' };
        }
    }

    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return { code: 'not_found', message: 'Context not found' };

    await storage.lockRootContextForUpdate(projectId, root.public_id);

    const currentHead = await findHead(storage, root.public_id);
    if (!currentHead) return { code: 'internal', message: 'HEAD not found' };

    // load the ordered messages under the current head
    const orderedNodes = await getOrderedNodes(storage, currentHead.public_id);

    const deletedResolved = resolveSelectorsToClientNodeIds(orderedNodes, rawIds);
    if (!deletedResolved.ok) return { code: deletedResolved.code, message: deletedResolved.message };
    const deletedClientIds = deletedResolved.data;

    const idsToDelete: string[] = [];
    for (const input of rawIds) {
        const resolved = resolveMessagePublicId(orderedNodes, input);
        if ('code' in resolved) return { code: resolved.code, message: resolved.message };
        idsToDelete.push(resolved.publicId);
    }
    const deleteSet = new Set(idsToDelete);

    // create new version head
    const newHeadId = generatePublicId('context');
    try {
        await storage.insertNodes({
            public_id: newHeadId,
            project_id: projectId,
            type: 'context',
            context_id: root.public_id,
            prev_id: currentHead.public_id,
            content: {},
            metadata: { operation: 'delete', affected: idsToDelete, ...(userMetadata ?? {}) },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create version head';
        return { code: 'internal', message };
    }

    // build filtered node copies (copy-on-write of the survivors)
    const filtered = orderedNodes.filter((n) => !deleteSet.has(n.public_id));
    const newNodes = filtered.map((n) => ({
        public_id: generatePublicId('msg'),
        project_id: projectId,
        type: 'message',
        context_id: newHeadId,
        parent_id: n.public_id,
        prev_id: null as string | null,
        content: n.content,
        metadata: stampMetadataClientNodeId(n.public_id, n.metadata as Record<string, unknown>),
    }));

    // link the copies in order via prev_id
    for (let i = 1; i < newNodes.length; i++) {
        newNodes[i].prev_id = newNodes[i - 1].public_id;
    }

    // persist the survivors, rolling back the orphaned head on failure
    if (newNodes.length > 0) {
        try {
            await storage.insertNodes(newNodes);
        } catch {
            await rollbackHead(storage, projectId, newHeadId);
            return { code: 'internal', message: 'Failed to delete messages' };
        }
    }

    // recompute the current version after the delete head landed
    const versions = await getVersions(storage, root.public_id);
    const currentVersion = versions.length - 1;
    const result: MessageView[] = newNodes.map((n, index: number) => ({
        ...n.content,
        id: n.public_id,
        index,
        metadata: n.metadata,
    }));

    return { data: result, version: currentVersion, deleted_client_ids: deletedClientIds };
}

export async function deleteMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    params: DeleteMessagesParams,
    options?: { inTransaction?: boolean },
): Promise<Result<DeleteSuccess>> {
    const runInTx = async (tx: StorageAdapter) => deleteMessagesOnce(tx, projectId, contextId, params);

    if (options?.inTransaction) {
        const outcome = await runInTx(storage);
        if ('code' in outcome) return err(outcome.code, outcome.message);
        return ok(outcome);
    }

    for (let attempt = 0; attempt < UPDATE_RETRY_ATTEMPTS; attempt += 1) {
        try {
            const outcome = await storage.transaction<DeleteOutcome>(async (tx) => runInTx(tx), {
                isolationLevel: 'serializable',
            });
            if ('code' in outcome) return err(outcome.code, outcome.message);
            return ok(outcome);
        } catch (error) {
            if (updateErrorCode(error) === 'conflict') {
                await sleep(5 * (attempt + 1));
                continue;
            }
            return err('internal', 'Failed to delete messages');
        }
    }

    return err('conflict', 'Concurrent delete retries exhausted; retry the request');
}
