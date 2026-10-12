import { findHead, getOrderedNodes } from '../context-chain';
import type { StorageAdapter } from '../storage';

const ENCRYPTED_MARKER = '__ic_enc';

function contentIsEncrypted(content: Record<string, unknown> | undefined): boolean {
    return Boolean(content && content[ENCRYPTED_MARKER] === 1);
}

export type ContextEncryptionState = 'empty' | 'all_plaintext' | 'all_encrypted' | 'mixed';

export async function getContextEncryptionState(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
): Promise<ContextEncryptionState | 'not_found'> {
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return 'not_found';

    const head = await findHead(storage, root.public_id);
    if (!head) return 'empty';

    const nodes = await getOrderedNodes(storage, head.public_id);
    if (nodes.length === 0) return 'empty';

    let plain = 0;
    let enc = 0;
    for (const node of nodes) {
        if (contentIsEncrypted(node.content)) enc += 1;
        else plain += 1;
    }
    if (plain > 0 && enc > 0) return 'mixed';
    if (enc === nodes.length) return 'all_encrypted';
    return 'all_plaintext';
}
