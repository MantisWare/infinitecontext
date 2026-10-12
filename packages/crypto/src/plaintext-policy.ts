import { CLEARTEXT_METADATA_KEYS } from './constants';
import { isEncryptedContent } from './node-payload';
import { assertStrictEncryptedEnvelope, validateEncryptedWriteShape } from './envelope-schema';

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

export function extractMessageWrites(body: unknown): Array<{ content: Record<string, unknown>; metadata: Record<string, unknown> }> {
    const items: Array<{ content: Record<string, unknown>; metadata: Record<string, unknown> }> = [];
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
        const { metadata, id: _id, index: _index, ...content } = rec;
        items.push({
            content: content as Record<string, unknown>,
            metadata: (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>,
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

export function deleteBodyMetadata(body: unknown): Record<string, unknown> | undefined {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const metadata = (body as Record<string, unknown>).metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
}
