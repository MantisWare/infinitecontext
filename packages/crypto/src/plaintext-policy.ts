import { CLEARTEXT_METADATA_KEYS, CLIENT_NODE_ID_PATTERN, SERVER_MSG_ID_PATTERN } from './constants';
import { isEncryptedContent } from './node-payload';
import { assertStrictEncryptedEnvelope, validateEncryptedWriteShape } from './envelope-schema';

const ALLOWED_MESSAGE_TOP_KEYS = new Set([
    'id',
    'index',
    'metadata',
    'created_at',
    '__ic_enc',
    'kid',
    'v',
    'alg',
    'nonce',
    'ct',
]);

const SENSITIVE_METADATA_WRAP_KEY = 'ic_sensitive';

export function metadataHasSensitivePlaintext(metadata: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(metadata)) {
        if ((CLEARTEXT_METADATA_KEYS as readonly string[]).includes(key)) continue;
        if (key === SENSITIVE_METADATA_WRAP_KEY) {
            if (value && typeof value === 'object' && isEncryptedContent(value as Record<string, unknown>)) {
                try {
                    assertStrictEncryptedEnvelope(value, 'metadata.ic_sensitive');
                    continue;
                } catch {
                    return true;
                }
            }
            return true;
        }
        if (value !== undefined && value !== null) return true;
    }
    return false;
}

function stripWriteSelectors(content: Record<string, unknown>): Record<string, unknown> {
    const { id: _id, index: _index, ...rest } = content;
    return rest;
}

export function isEncryptedWritePayload(content: Record<string, unknown>, metadata: Record<string, unknown>): boolean {
    try {
        validateEncryptedWriteShape(stripWriteSelectors(content), metadata);
        return true;
    } catch {
        return false;
    }
}

export function extractMessageWrites(
    body: unknown,
): Array<{ content: Record<string, unknown>; metadata: Record<string, unknown>; clientNodeId?: string }> {
    const items: Array<{
        content: Record<string, unknown>;
        metadata: Record<string, unknown>;
        clientNodeId?: string;
    }> = [];
    let topLevelMetadata: Record<string, unknown> | undefined;

    const pushOne = (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const rec = raw as Record<string, unknown>;
        if (Array.isArray(rec.updates)) {
            if (rec.metadata !== undefined) {
                topLevelMetadata =
                    rec.metadata && typeof rec.metadata === 'object' && !Array.isArray(rec.metadata)
                        ? (rec.metadata as Record<string, unknown>)
                        : {};
            }
            for (const update of rec.updates) pushOne(update);
            return;
        }
        const { metadata, id, index: _index, ...content } = rec;
        const metaObj = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
        const clientNodeId =
            typeof id === 'string'
                ? id
                : typeof metaObj.ic_client_node_id === 'string'
                  ? metaObj.ic_client_node_id
                  : undefined;
        items.push({
            content: content as Record<string, unknown>,
            metadata: metaObj,
            clientNodeId,
        });
    };

    if (Array.isArray(body)) {
        for (const item of body) pushOne(item);
    } else {
        pushOne(body);
    }

    if (topLevelMetadata && metadataHasSensitivePlaintext(topLevelMetadata)) {
        items.push({ content: {}, metadata: topLevelMetadata });
    }

    return items;
}

export function contextRootMetadata(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    const metadata = (body as Record<string, unknown>).metadata;
    return (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
}

export function isClientNodeId(value: unknown): value is string {
    return typeof value === 'string' && CLIENT_NODE_ID_PATTERN.test(value);
}

export function isVaultMessageWriteId(value: unknown): value is string {
    return typeof value === 'string' && (CLIENT_NODE_ID_PATTERN.test(value) || SERVER_MSG_ID_PATTERN.test(value));
}

function contentEnvelopeOnly(row: Record<string, unknown>): Record<string, unknown> {
    return {
        __ic_enc: row.__ic_enc,
        kid: row.kid,
        v: row.v,
        alg: row.alg,
        nonce: row.nonce,
        ct: row.ct,
    };
}

export function vaultMessageRowViolations(row: Record<string, unknown>): string[] {
    const violations: string[] = [];
    for (const key of Object.keys(row)) {
        if (!ALLOWED_MESSAGE_TOP_KEYS.has(key)) violations.push(`forbidden field: ${key}`);
    }
    if (!isEncryptedContent(row)) violations.push('content not encrypted');
    else {
        try {
            assertStrictEncryptedEnvelope(contentEnvelopeOnly(row), 'content');
        } catch (error) {
            violations.push(error instanceof Error ? error.message : 'invalid content envelope');
        }
    }
    const metadata = row.metadata;
    if (metadata !== undefined && metadata !== null) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            violations.push('metadata must be an object');
        } else if (metadataHasSensitivePlaintext(metadata as Record<string, unknown>)) {
            violations.push('metadata contains sensitive plaintext');
        }
    }
    return violations;
}

export function deleteBodyMetadata(body: unknown): Record<string, unknown> | undefined {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const metadata = (body as Record<string, unknown>).metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
}
