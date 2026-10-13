// =============================================================================
// APPEND MESSAGES — append messages to a context (ported from POST /contexts/:id)
// =============================================================================

import { appendErrorCode } from './append-errors';
import { buildNodeInsertRecords, findHead, findTail, getOrderedNodes, getVersions } from '../context-chain';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ensurePlaintextAppendClientNodeId } from '../ic-client-node-id';
import { ok, err, type Result } from '../result';

// -- intermediate tx outcome --------------------------------------------------
// Mirrors the handler: the serializable tx returns either the success payload
// or an error marker carrying the original HTTP status, resolved to a Result
// once the tx completes.

type AppendOutcome =
    | { data: MessageView[]; version: number }
    | { code: 'not_found' | 'internal' | 'conflict' | 'invalid_input'; message: string };

const CLIENT_NODE_ID_PATTERN = /^icn_[0-9a-f]{24}$/;

// -- op -----------------------------------------------------------------------

export async function appendMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    messages: object | object[],
): Promise<Result<{ data: MessageView[]; version: number }>> {
    // Serializable tx so concurrent permanent-delete can't race with append
    // (Postgres SSI makes one side fail with 40001; client retries).
    let outcome: AppendOutcome;
    try {
        outcome = await storage.transaction<AppendOutcome>(async (tx) => {
            // context must exist under this project
            const root = await tx.findRootContext(projectId, contextId);
            if (!root) return { code: 'not_found', message: 'Context not found' };

            // resolve the current head of the context chain
            const head = await findHead(tx, root.public_id);
            if (!head) return { code: 'internal', message: 'HEAD not found' };

            // normalize input to an array and locate the existing tail
            const items = Array.isArray(messages) ? messages : [messages];
            const existingNodes = await getOrderedNodes(tx, head.public_id);
            const existingCount = existingNodes.length;
            const tailPublicId = await findTail(tx, head.public_id);

            // split metadata out of each message; the rest is content
            const nodeInputs = items.map((msg) => {
                const { metadata, id, ...content } = msg as Record<string, unknown>;
                const clientPublicId = typeof id === 'string' ? id : undefined;
                if (clientPublicId !== undefined && !CLIENT_NODE_ID_PATTERN.test(clientPublicId)) {
                    return { invalidId: true as const };
                }
                const contentRecord = content as Record<string, unknown>;
                const baseMeta = (metadata ?? {}) as Record<string, unknown>;
                const stampedMeta = ensurePlaintextAppendClientNodeId(contentRecord, baseMeta, clientPublicId);
                return {
                    type: 'message',
                    content: contentRecord,
                    metadata: stampedMeta,
                    clientPublicId,
                };
            });
            if (nodeInputs.some((n) => 'invalidId' in n)) {
                return { code: 'invalid_input', message: 'Message id must be icn_ followed by 24 lowercase hex digits' };
            }
            const typedInputs = nodeInputs as Array<{
                type: string;
                content: Record<string, unknown>;
                metadata: Record<string, unknown>;
                clientPublicId?: string;
            }>;
            for (const input of typedInputs) {
                if (!input.clientPublicId) continue;
                const existing = await tx.findNodeByPublicId(projectId, input.clientPublicId);
                if (existing) {
                    return { code: 'conflict', message: 'Client node id is already in use for this account' };
                }
            }
            const insertRecords = buildNodeInsertRecords(typedInputs, projectId, head.public_id, tailPublicId);

            // append the new message nodes after the tail
            const createdNodes = await tx.insertNodes(insertRecords);

            // version reflects the current head count (append adds no new head)
            const versions = await getVersions(tx, root.public_id);
            const currentVersion = versions.length - 1;

            // shape each created node: content + generated id + index + metadata
            const data: MessageView[] = createdNodes.map((node, i: number) => ({
                ...(node.content ?? {}),
                id: node.public_id!,
                index: existingCount + i,
                metadata: node.metadata ?? {},
            }));

            return { data, version: currentVersion };
        }, { isolationLevel: 'serializable' });
    } catch (error) {
        const mapped = appendErrorCode(error);
        if (mapped === 'conflict') {
            return err('conflict', 'Concurrent append or client node id conflict; retry or run vault migrate-project');
        }
        return err('internal', 'Failed to append messages');
    }

    // resolve the intermediate error marker to a Result error
    if ('code' in outcome) return err(outcome.code, outcome.message);
    return ok({ data: outcome.data, version: outcome.version });
}
