import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

import { bytesToBase64, base64ToBytes } from './encoding';
import { ENCRYPTED_CONTENT_MARKER } from './node-payload';

export const CHAIN_SCHEME_VERSION = 1 as const;

export function generateClientNodeId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `icn_${hex}`;
}

const CHAIN_INFO = new TextEncoder().encode('infinitecontext-vault-chain-v1');

export function deriveContextChainKey(dek: Uint8Array, contextId: string, dekVersion: number): Uint8Array {
    const material = new TextEncoder().encode(`${contextId}|dek_v${dekVersion}`);
    return hmac(sha256, dek, new Uint8Array([...CHAIN_INFO, ...material]));
}

export function envelopeContentDigest(content: Record<string, unknown>): Uint8Array {
    const canonical = JSON.stringify({
        alg: content.alg,
        ct: content.ct,
        kid: content.kid,
        nonce: content.nonce,
        v: content.v,
        [ENCRYPTED_CONTENT_MARKER]: content[ENCRYPTED_CONTENT_MARKER],
    });
    return sha256(new TextEncoder().encode(canonical));
}

export function computeChainLink(
    chainKey: Uint8Array,
    contextId: string,
    chainIndex: number,
    messageId: string,
    content: Record<string, unknown>,
    prevLinkB64: string,
): string {
    const digest = envelopeContentDigest(content);
    const payload = new TextEncoder().encode(
        ['v1', contextId, String(chainIndex), messageId, bytesToBase64(digest), prevLinkB64].join('|'),
    );
    return bytesToBase64(hmac(sha256, chainKey, payload));
}

export type ChainCleartext = {
    ic_chain_index: number;
    ic_chain_link: string;
};

export class ChainVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ChainVerificationError';
    }
}

export function stableClientNodeId(row: { id: string; metadata?: Record<string, unknown> }): string {
    const meta = row.metadata ?? {};
    const fromMeta = meta.ic_client_node_id;
    if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
    return String(row.id);
}

export function verifyContextMessageChain(
    messages: Array<{ id: string; metadata?: Record<string, unknown>; [key: string]: unknown }>,
    chainKey: Uint8Array,
    contextId: string,
    {
        pickContent,
        minExpectedMaxIndex,
    }: { pickContent: (row: Record<string, unknown>) => Record<string, unknown>; minExpectedMaxIndex?: number },
): void {
    const rows = messages
        .map((m) => ({
            id: stableClientNodeId(m),
            metadata: (m.metadata ?? {}) as Record<string, unknown>,
            content: pickContent(m as Record<string, unknown>),
        }))
        .filter((r) => r.metadata.ic_chain_index !== undefined);

    if (rows.length === 0) return;

    rows.sort((a, b) => Number(a.metadata.ic_chain_index) - Number(b.metadata.ic_chain_index));

    let prevLink = 'GENESIS';
    const seenIndex = new Set<number>();
    let maxIndex = -1;

    for (const row of rows) {
        const chainIndex = Number(row.metadata.ic_chain_index);
        const link = String(row.metadata.ic_chain_link ?? '');
        if (!Number.isInteger(chainIndex) || chainIndex < 0) {
            throw new ChainVerificationError('Invalid ic_chain_index');
        }
        if (seenIndex.has(chainIndex)) {
            throw new ChainVerificationError(`Duplicate ic_chain_index ${chainIndex} (possible rollback)`);
        }
        seenIndex.add(chainIndex);
        maxIndex = Math.max(maxIndex, chainIndex);

        const expected = computeChainLink(chainKey, contextId, chainIndex, row.id, row.content, prevLink);
        if (link !== expected) {
            throw new ChainVerificationError(`Chain link mismatch at index ${chainIndex}`);
        }
        prevLink = link;
    }

    if (minExpectedMaxIndex !== undefined && maxIndex < minExpectedMaxIndex) {
        throw new ChainVerificationError('Missing newer chain indices (possible truncation)');
    }
}

export function parseChainLinkB64(value: string): Uint8Array {
    return base64ToBytes(value);
}
