import { ENVELOPE_VERSION, CLEARTEXT_METADATA_KEYS, type CleartextMetadataKey } from './constants';
import { decryptAead, encryptAead, type AeadEnvelope } from './aead';
import { bytesToBase64, base64ToBytes } from './encoding';

export const ENCRYPTED_CONTENT_MARKER = '__ic_enc' as const;

export type NodeCryptoAad = {
    contextId: string;
    userPublicId: string;
    dekVersion: number;
    field: 'content' | 'metadata_sensitive';
};

export function buildNodeAad(parts: NodeCryptoAad): Uint8Array {
    const canonical = ['v1', parts.userPublicId, parts.contextId, String(parts.dekVersion), parts.field].join('|');
    return new TextEncoder().encode(canonical);
}

export type EncryptedFieldEnvelope = AeadEnvelope & { kid: string };

function isEncryptedField(value: unknown): value is { [ENCRYPTED_CONTENT_MARKER]: number; kid: string } & AeadEnvelope {
    if (!value || typeof value !== 'object') return false;
    const rec = value as Record<string, unknown>;
    return rec[ENCRYPTED_CONTENT_MARKER] === ENVELOPE_VERSION && typeof rec.kid === 'string';
}

export function encryptNodeContent(
    dek: Uint8Array,
    dekVersion: number,
    plaintext: Record<string, unknown>,
    aadParts: Omit<NodeCryptoAad, 'field'>,
): Record<string, unknown> {
    const json = new TextEncoder().encode(JSON.stringify(plaintext));
    const aad = buildNodeAad({ ...aadParts, field: 'content', dekVersion });
    const envelope = encryptAead(dek, json, aad);
    return {
        [ENCRYPTED_CONTENT_MARKER]: ENVELOPE_VERSION,
        kid: `dek_v${dekVersion}`,
        ...envelope,
    };
}

export function decryptNodeContent(
    dek: Uint8Array,
    wrapped: Record<string, unknown>,
    aadParts: Omit<NodeCryptoAad, 'field'>,
): Record<string, unknown> {
    if (!isEncryptedField(wrapped)) return wrapped;
    const dekVersion = parseDekVersion(String(wrapped.kid ?? ''));
    const aad = buildNodeAad({ ...aadParts, field: 'content', dekVersion });
    const pt = decryptAead(dek, wrapped as AeadEnvelope, aad);
    return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
}

export function splitMetadata(metadata: Record<string, unknown>): {
    cleartext: Record<string, unknown>;
    sensitive: Record<string, unknown>;
} {
    const cleartext: Record<string, unknown> = {};
    const sensitive: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
        if ((CLEARTEXT_METADATA_KEYS as readonly string[]).includes(key)) {
            cleartext[key] = value;
        } else if (key === ENCRYPTED_CONTENT_MARKER || key === 'kid' || key === 'v' || key === 'alg' || key === 'nonce' || key === 'ct') {
            // skip envelope keys if misplaced
        } else {
            sensitive[key] = value;
        }
    }
    return { cleartext, sensitive };
}

export function encryptNodeMetadata(
    dek: Uint8Array,
    dekVersion: number,
    metadata: Record<string, unknown>,
    aadParts: Omit<NodeCryptoAad, 'field'>,
): Record<string, unknown> {
    const { cleartext, sensitive } = splitMetadata(metadata);
    if (Object.keys(sensitive).length === 0) return cleartext;
    const json = new TextEncoder().encode(JSON.stringify(sensitive));
    const aad = buildNodeAad({ ...aadParts, field: 'metadata_sensitive', dekVersion });
    const envelope = encryptAead(dek, json, aad);
    return {
        ...cleartext,
        ic_sensitive: {
            [ENCRYPTED_CONTENT_MARKER]: ENVELOPE_VERSION,
            kid: `dek_v${dekVersion}`,
            ...envelope,
        },
    };
}

export function decryptNodeMetadata(
    dek: Uint8Array,
    metadata: Record<string, unknown>,
    aadParts: Omit<NodeCryptoAad, 'field'>,
): Record<string, unknown> {
    const sensitiveWrap = metadata.ic_sensitive;
    if (!sensitiveWrap || typeof sensitiveWrap !== 'object') return metadata;
    const wrap = sensitiveWrap as Record<string, unknown>;
    if (!isEncryptedField(wrap)) return metadata;

    const dekVersion = parseDekVersion(String(wrap.kid ?? ''));
    const aad = buildNodeAad({ ...aadParts, field: 'metadata_sensitive', dekVersion });
    const pt = decryptAead(dek, wrap as AeadEnvelope, aad);
    const sensitive = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    const { ic_sensitive: _removed, ...cleartext } = metadata;
    return { ...cleartext, ...sensitive };
}

export function isEncryptedContent(content: Record<string, unknown>): boolean {
    return isEncryptedField(content);
}

export function parseDekVersion(kid: string): number {
    const match = /^dek_v(\d+)$/.exec(kid);
    if (!match) return 1;
    return Number.parseInt(match[1]!, 10);
}

export function pickCleartextMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of CLEARTEXT_METADATA_KEYS) {
        if (metadata[key] !== undefined) out[key as CleartextMetadataKey] = metadata[key];
    }
    return out;
}
