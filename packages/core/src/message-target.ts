import type { NodeRow } from './storage';

const CLIENT_NODE_ID_PATTERN = /^icn_[0-9a-f]{24}$/;

type OrderedNode = Pick<NodeRow, 'public_id' | 'metadata'>;

export function resolveMessagePublicId(
    orderedNodes: OrderedNode[],
    selector: string | number,
): { publicId: string } | { code: 'not_found' | 'invalid_input'; message: string } {
    if (typeof selector === 'number') {
        let idx = selector;
        if (idx < 0) idx = orderedNodes.length + idx;
        if (idx < 0 || idx >= orderedNodes.length) {
            return { code: 'invalid_input', message: `Index out of range: ${selector}` };
        }
        return { publicId: orderedNodes[idx]!.public_id! };
    }

    if (CLIENT_NODE_ID_PATTERN.test(selector)) {
        const byClient = orderedNodes.find(
            (n) =>
                (n.metadata && typeof n.metadata === 'object' && (n.metadata as Record<string, unknown>).ic_client_node_id === selector) ||
                n.public_id === selector,
        );
        if (!byClient?.public_id) {
            return { code: 'not_found', message: `Message not found: ${selector}` };
        }
        return { publicId: byClient.public_id };
    }

    const nodeIds = new Set(orderedNodes.map((n) => n.public_id));
    if (!nodeIds.has(selector)) {
        return { code: 'not_found', message: `Message not found: ${selector}` };
    }
    return { publicId: selector };
}

export function clientNodeIdFromMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
    const id = metadata?.ic_client_node_id;
    return typeof id === 'string' && CLIENT_NODE_ID_PATTERN.test(id) ? id : null;
}
