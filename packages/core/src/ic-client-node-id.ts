import { createHash, randomBytes } from 'node:crypto';

export const CLIENT_NODE_ID_PATTERN = /^icn_[0-9a-f]{24}$/;

export function generateClientNodeId(): string {
    return `icn_${randomBytes(12).toString('hex')}`;
}

/** Stable icn for legacy rows — must match postgres migration 008 backfill. */
export function deterministicClientNodeIdFromPublicId(publicId: string): string {
    const hex = createHash('sha256').update(publicId, 'utf8').digest('hex').slice(0, 24);
    return `icn_${hex}`;
}

export function isEncryptedVaultContent(content: Record<string, unknown> | null | undefined): boolean {
    return Boolean(content && typeof content === 'object' && content.__ic_enc === 1);
}

export function clientNodeIdFromMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
    const id = metadata?.ic_client_node_id;
    return typeof id === 'string' && CLIENT_NODE_ID_PATTERN.test(id) ? id : null;
}

/** Resolve stable icn for sync targeting: metadata, then deterministic from public id. */
export function stableClientNodeIdForMessage(
    publicId: string,
    metadata: Record<string, unknown> | null | undefined,
): string {
    return clientNodeIdFromMetadata(metadata) ?? deterministicClientNodeIdFromPublicId(publicId);
}

/** Ensure metadata carries stable ic_client_node_id (uses parent/source public id for legacy rows). */
export function stampMetadataClientNodeId(
    sourcePublicId: string,
    metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
    const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
    const icn = stableClientNodeIdForMessage(sourcePublicId, base);
    if (base.ic_client_node_id === icn) return base;
    return { ...base, ic_client_node_id: icn };
}

/**
 * Plaintext appends: server assigns ic_client_node_id when missing.
 * Vault ciphertext: keep client metadata / id; do not invent server icn on encrypted body.
 */
export function ensurePlaintextAppendClientNodeId(
    content: Record<string, unknown>,
    metadata: Record<string, unknown>,
    explicitClientId?: string,
): Record<string, unknown> {
    if (isEncryptedVaultContent(content)) {
        const existing = clientNodeIdFromMetadata(metadata) ?? (explicitClientId && CLIENT_NODE_ID_PATTERN.test(explicitClientId) ? explicitClientId : null);
        if (existing) return { ...metadata, ic_client_node_id: existing };
        return metadata;
    }
    const existing =
        clientNodeIdFromMetadata(metadata) ??
        (explicitClientId && CLIENT_NODE_ID_PATTERN.test(explicitClientId) ? explicitClientId : null);
    const icClient = existing ?? generateClientNodeId();
    return { ...metadata, ic_client_node_id: icClient };
}
