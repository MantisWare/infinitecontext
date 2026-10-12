import { CLEARTEXT_METADATA_KEYS } from './constants';
import { isEncryptedContent } from './node-payload';

const SENSITIVE_METADATA_WRAP_KEY = 'ic_sensitive';

export function metadataHasSensitivePlaintext(metadata: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(metadata)) {
        if ((CLEARTEXT_METADATA_KEYS as readonly string[]).includes(key)) continue;
        if (key === SENSITIVE_METADATA_WRAP_KEY) {
            if (value && typeof value === 'object' && isEncryptedContent(value as Record<string, unknown>)) continue;
            return true;
        }
        if (value !== undefined && value !== null) return true;
    }
    return false;
}

export function isEncryptedWritePayload(content: Record<string, unknown>, metadata: Record<string, unknown>): boolean {
    if (!isEncryptedContent(content)) return false;
    if (!metadataHasSensitivePlaintext(metadata)) return true;
    const wrap = metadata[SENSITIVE_METADATA_WRAP_KEY];
    return Boolean(wrap && typeof wrap === 'object' && isEncryptedContent(wrap as Record<string, unknown>));
}

export function extractMessageWrites(body: unknown): Array<{ content: Record<string, unknown>; metadata: Record<string, unknown> }> {
    const items: Array<{ content: Record<string, unknown>; metadata: Record<string, unknown> }> = [];
    const pushOne = (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const rec = raw as Record<string, unknown>;
        if (Array.isArray(rec.updates)) {
            for (const update of rec.updates) pushOne(update);
            return;
        }
        const { metadata, ...content } = rec;
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
    return items;
}

export function contextRootMetadata(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    const metadata = (body as Record<string, unknown>).metadata;
    return (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
}
