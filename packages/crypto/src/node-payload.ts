import { ENVELOPE_VERSION, CLEARTEXT_METADATA_KEYS, ROOT_METADATA_AAD_FIELD, type CleartextMetadataKey } from './constants';
import { DecryptionFailedError, decryptAead, encryptAead, type AeadEnvelope } from './aead';
import { bytesToBase64, base64ToBytes } from './encoding';
import { assertStrictEncryptedEnvelope } from './envelope-schema';

export const ENCRYPTED_CONTENT_MARKER = '__ic_enc' as const;

export type NodeCryptoAad = {
    contextId: string;
    userPublicId: string;
    dekVersion: number;
    field: 'content' | 'metadata_sensitive' | typeof ROOT_METADATA_AAD_FIELD;
    /** Stable client-chosen message id (vault v4+). */
    nodePublicId?: string;
    /** Legacy v3 ordinal binding (deprecated; decrypt only). */
    nodeIndex?: number;
    aadVersion?: 'v3' | 'v4';
};

export function buildNodeAad(parts: NodeCryptoAad): Uint8Array {
    const version = parts.aadVersion ?? (parts.nodePublicId ? 'v4' : 'v3');
    if (version === 'v4') {
        const nodeId = parts.nodePublicId ?? '';
        const canonical = [
            'v4',
            parts.userPublicId,
            parts.contextId,
            String(parts.dekVersion),
            parts.field,
            nodeId,
        ].join('|');
        return new TextEncoder().encode(canonical);
    }
    const nodeIndex = parts.nodeIndex === undefined ? '' : String(parts.nodeIndex);
    const canonical = [
        'v3',
        parts.userPublicId,
        parts.contextId,
        String(parts.dekVersion),
        parts.field,
        nodeIndex,
    ].join('|');
    return new TextEncoder().encode(canonical);
}

export function buildRootMetadataContextAad(userPublicId: string, rootAadNonce: string): string {
    return `${userPublicId}|${rootAadNonce}`;
}

export type EncryptedFieldEnvelope = AeadEnvelope & { kid: string };

function isEncryptedField(value: unknown): value is { [ENCRYPTED_CONTENT_MARKER]: number; kid: string } & AeadEnvelope {
    if (!value || typeof value !== 'object') return false;
    const rec = value as Record<string, unknown>;
    return rec[ENCRYPTED_CONTENT_MARKER] === ENVELOPE_VERSION && typeof rec.kid === 'string';
}

export type EncryptNodeOptions = {
    requireNodeBinding?: boolean;
};

export function encryptNodeContent(
    dek: Uint8Array,
    dekVersion: number,
    plaintext: Record<string, unknown>,
    aadParts: Omit<NodeCryptoAad, 'field' | 'dekVersion'>,
    options?: EncryptNodeOptions,
): Record<string, unknown> {
    if (options?.requireNodeBinding !== false && !aadParts.nodePublicId && aadParts.nodeIndex === undefined) {
        throw new Error('nodePublicId is required for message content encryption');
    }
    const json = new TextEncoder().encode(JSON.stringify(plaintext));
    const aad = buildNodeAad({
        ...aadParts,
        field: 'content',
        dekVersion,
        aadVersion: aadParts.nodePublicId ? 'v4' : 'v3',
    });
    const envelope = encryptAead(dek, json, aad);
    return {
        [ENCRYPTED_CONTENT_MARKER]: ENVELOPE_VERSION,
        kid: `dek_v${dekVersion}`,
        ...envelope,
    };
}

export type DecryptNodeOptions = {
    allowPlaintext?: boolean;
    rootMetadata?: boolean;
};

export function decryptNodeContent(
    dek: Uint8Array,
    wrapped: Record<string, unknown>,
    aadParts: Omit<NodeCryptoAad, 'field' | 'dekVersion'>,
    options?: DecryptNodeOptions,
): Record<string, unknown> {
    if (!isEncryptedField(wrapped)) {
        if (options?.allowPlaintext) return wrapped;
        throw new DecryptionFailedError('Expected encrypted message content');
    }
    assertStrictEncryptedEnvelope(wrapped, 'content');
    const dekVersion = parseDekVersion(String(wrapped.kid ?? ''));
    const tryDecrypt = (aadVersion: 'v3' | 'v4') => {
        const aad = buildNodeAad({ ...aadParts, field: 'content', dekVersion, aadVersion });
        const pt = decryptAead(dek, wrapped as AeadEnvelope, aad);
        return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    };
    if (aadParts.nodePublicId) {
        try {
            return tryDecrypt('v4');
        } catch (first) {
            if (aadParts.nodeIndex === undefined) throw first;
        }
    }
    return tryDecrypt(aadParts.nodeIndex !== undefined ? 'v3' : 'v4');
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
    aadParts: Omit<NodeCryptoAad, 'field' | 'dekVersion'>,
    options?: { rootMetadata?: boolean },
): Record<string, unknown> {
    const { cleartext, sensitive } = splitMetadata(metadata);
    if (Object.keys(sensitive).length === 0) return cleartext;
    const field = options?.rootMetadata ? ROOT_METADATA_AAD_FIELD : ('metadata_sensitive' as const);
    const rootNonce = typeof cleartext.ic_root_aad === 'string' ? cleartext.ic_root_aad : undefined;
    const contextId =
        field === ROOT_METADATA_AAD_FIELD && rootNonce
            ? buildRootMetadataContextAad(aadParts.userPublicId, rootNonce)
            : aadParts.contextId;
    const json = new TextEncoder().encode(JSON.stringify(sensitive));
    const aad = buildNodeAad({
        ...aadParts,
        contextId,
        field,
        dekVersion,
        nodePublicId: field === ROOT_METADATA_AAD_FIELD ? undefined : aadParts.nodePublicId,
        nodeIndex: field === ROOT_METADATA_AAD_FIELD ? undefined : aadParts.nodeIndex,
        aadVersion: aadParts.nodePublicId ? 'v4' : 'v3',
    });
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
    aadParts: Omit<NodeCryptoAad, 'field' | 'dekVersion'>,
    options?: DecryptNodeOptions,
): Record<string, unknown> {
    const sensitiveWrap = metadata.ic_sensitive;
    if (!sensitiveWrap || typeof sensitiveWrap !== 'object') {
        if (options?.allowPlaintext) return metadata;
        if (metadataHasAnySensitivePlaintext(metadata)) {
            throw new DecryptionFailedError('Expected encrypted sensitive metadata');
        }
        return metadata;
    }
    const wrap = sensitiveWrap as Record<string, unknown>;
    if (!isEncryptedField(wrap)) {
        if (options?.allowPlaintext) return metadata;
        throw new DecryptionFailedError('Expected encrypted sensitive metadata');
    }
    assertStrictEncryptedEnvelope(wrap, 'metadata.ic_sensitive');

    const rootNonce =
        options?.rootMetadata && typeof metadata.ic_root_aad === 'string' ? metadata.ic_root_aad : undefined;
    const field = rootNonce ? ROOT_METADATA_AAD_FIELD : ('metadata_sensitive' as const);
    const contextId =
        field === ROOT_METADATA_AAD_FIELD && rootNonce
            ? buildRootMetadataContextAad(aadParts.userPublicId, rootNonce)
            : aadParts.contextId;

    const dekVersion = parseDekVersion(String(wrap.kid ?? ''));
    const tryDecrypt = (aadVersion: 'v3' | 'v4') => {
        const aad = buildNodeAad({
            ...aadParts,
            contextId,
            field,
            dekVersion,
            nodePublicId: field === ROOT_METADATA_AAD_FIELD ? undefined : aadParts.nodePublicId,
            nodeIndex: field === ROOT_METADATA_AAD_FIELD ? undefined : aadParts.nodeIndex,
            aadVersion,
        });
        const pt = decryptAead(dek, wrap as AeadEnvelope, aad);
        return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    };
    let sensitive: Record<string, unknown>;
    try {
        sensitive = aadParts.nodePublicId ? tryDecrypt('v4') : tryDecrypt('v3');
    } catch (first) {
        if (aadParts.nodePublicId && aadParts.nodeIndex !== undefined) {
            sensitive = tryDecrypt('v3');
        } else {
            throw first;
        }
    }
    const { ic_sensitive: _removed, ...cleartext } = metadata;
    return { ...cleartext, ...sensitive };
}

function metadataHasAnySensitivePlaintext(metadata: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(metadata)) {
        if ((CLEARTEXT_METADATA_KEYS as readonly string[]).includes(key)) continue;
        if (key === 'ic_sensitive') continue;
        if (value !== undefined && value !== null) return true;
    }
    return false;
}

export function isEncryptedContent(content: Record<string, unknown>): boolean {
    return isEncryptedField(content);
}

export function parseDekVersion(kid: string): number {
    const match = /^dek_v(\d+)$/.exec(kid);
    if (!match) throw new DecryptionFailedError(`Unknown encryption key id: ${kid}`);
    return Number.parseInt(match[1]!, 10);
}

export function pickCleartextMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of CLEARTEXT_METADATA_KEYS) {
        if (metadata[key] !== undefined) out[key as CleartextMetadataKey] = metadata[key];
    }
    return out;
}
