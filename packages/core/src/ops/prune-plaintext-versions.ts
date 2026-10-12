// =============================================================================
// PRUNE PLAINTEXT VERSION HEADS — remove pre-migration history snapshots that
// still store plaintext message payloads (vault migrate helper).
// =============================================================================

import { getOrderedNodes, getVersions } from '../context-chain';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

const ENCRYPTED_MARKER = '__ic_enc';

function contentIsEncrypted(content: Record<string, unknown> | undefined): boolean {
    return Boolean(content && content[ENCRYPTED_MARKER] === 1);
}

export async function prunePlaintextVersionHeads(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
): Promise<Result<{ pruned: number }>> {
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    let pruned = 0;
    for (;;) {
        const versions = await getVersions(storage, root.public_id);
        if (versions.length <= 1) break;

        const oldest = versions[0]!;
        const nodes = await getOrderedNodes(storage, oldest.head_id);
        if (nodes.length === 0) {
            await storage.deleteNodeByPublicId(projectId, oldest.head_id);
            pruned += 1;
            continue;
        }

        const anyPlain = nodes.some((n) => !contentIsEncrypted(n.content));
        const anyEnc = nodes.some((n) => contentIsEncrypted(n.content));
        if (!anyPlain) break;
        if (anyEnc) {
            return err(
                'invalid_input',
                'Historical version contains mixed plaintext and ciphertext; encrypt or delete that version manually',
            );
        }

        const deletedHeadId = oldest.head_id;
        await storage.deleteNodesByContextId(projectId, deletedHeadId);
        await storage.deleteNodeByPublicId(projectId, deletedHeadId);

        const remaining = await getVersions(storage, root.public_id);
        const newOldest = remaining[0];
        if (newOldest && newOldest.head_id !== deletedHeadId) {
            const branches = await storage.findContextBranches(root.public_id);
            const branch = branches.find((b) => b.public_id === newOldest.head_id);
            if (branch?.prev_id === deletedHeadId) {
                await storage.updateNodePrevId(projectId, newOldest.head_id, null);
            }
        }

        pruned += 1;
    }

    return ok({ pruned });
}
