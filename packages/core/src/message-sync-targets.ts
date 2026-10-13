import { findHead, getOrderedNodes } from './context-chain';
import { clientNodeIdFromMetadata, resolveMessagePublicId } from './message-target';
import type { NodeRow, StorageAdapter } from './storage';
import { err, ok, type Result } from './result';

const CLIENT_NODE_ID_PATTERN = /^icn_[0-9a-f]{24}$/;

type OrderedNode = Pick<NodeRow, 'public_id' | 'metadata'>;

export function stableClientNodeIdFromNode(node: OrderedNode): string | null {
    return clientNodeIdFromMetadata(
        node.metadata && typeof node.metadata === 'object' ? (node.metadata as Record<string, unknown>) : null,
    );
}

export function resolveSelectorToClientNodeId(
    orderedNodes: OrderedNode[],
    selector: string | number,
    hintClientNodeId?: string | null,
): Result<{ publicId: string; clientNodeId: string }> {
    const resolved = resolveMessagePublicId(orderedNodes, selector);
    if ('code' in resolved) return err(resolved.code, resolved.message);
    const node = orderedNodes.find((n) => n.public_id === resolved.publicId);
    if (!node) return err('not_found', `Message not found: ${selector}`);
    const fromNode = stableClientNodeIdFromNode(node);
    const clientNodeId =
        fromNode ??
        (hintClientNodeId && CLIENT_NODE_ID_PATTERN.test(hintClientNodeId) ? hintClientNodeId : null);
    if (!clientNodeId || !CLIENT_NODE_ID_PATTERN.test(clientNodeId)) {
        return err('invalid_input', `Message lacks stable ic_client_node_id: ${selector}`);
    }
    return ok({ publicId: resolved.publicId, clientNodeId });
}

export function resolveSelectorsToClientNodeIds(
    orderedNodes: OrderedNode[],
    selectors: Array<string | number>,
): Result<string[]> {
    const ids: string[] = [];
    for (const selector of selectors) {
        const resolved = resolveSelectorToClientNodeId(orderedNodes, selector);
        if (!resolved.ok) return resolved;
        ids.push(resolved.data.clientNodeId);
    }
    return ok(ids);
}

export type UpdateSelectorInput = { id?: unknown; index?: unknown; metadata?: unknown };

function clientNodeIdHintFromUpdate(update: UpdateSelectorInput): string | null {
    if (!update.metadata || typeof update.metadata !== 'object' || Array.isArray(update.metadata)) {
        return null;
    }
    const id = (update.metadata as Record<string, unknown>).ic_client_node_id;
    return typeof id === 'string' && CLIENT_NODE_ID_PATTERN.test(id) ? id : null;
}

export function resolveUpdateSelectorsToClientNodeIds(
    orderedNodes: OrderedNode[],
    updates: UpdateSelectorInput[],
): Result<string[]> {
    const ids: string[] = [];
    for (const u of updates) {
        const selector = u.id !== undefined ? u.id : u.index;
        if (selector === undefined) return err('invalid_input', 'Either id or index required');
        if (typeof selector !== 'string' && typeof selector !== 'number') {
            return err('invalid_input', 'id or index must be a string or integer');
        }
        const resolved = resolveSelectorToClientNodeId(
            orderedNodes,
            selector as string | number,
            clientNodeIdHintFromUpdate(u),
        );
        if (!resolved.ok) return resolved;
        ids.push(resolved.data.clientNodeId);
    }
    return ok(ids);
}

export async function loadOrderedContextMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
): Promise<Result<OrderedNode[]>> {
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');
    const currentHead = await findHead(storage, root.public_id);
    if (!currentHead) return err('internal', 'HEAD not found');
    const orderedNodes = await getOrderedNodes(storage, currentHead.public_id);
    return ok(orderedNodes);
}
