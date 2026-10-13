import { parseStrictBaseSequence } from '@infinitecontext/core/sync';

import type { HttpContext } from '../types/http';

export type ParsedBaseSequence =
    | { status: 'missing' }
    | { status: 'invalid' }
    | { status: 'ok'; value: number };

export { parseStrictBaseSequence as parseSequenceNumber };

export function parseBaseSequence(c: HttpContext, body: unknown): ParsedBaseSequence {
    const header =
        c.req.header('X-IC-Base-Sequence') ??
        c.req.header('X-InfiniteContext-Base-Sequence') ??
        c.req.header('If-Match');
    if (header) {
        const trimmed = header.trim();
        const direct = parseStrictBaseSequence(trimmed);
        if (direct !== null) return { status: 'ok', value: direct };
        const match = trimmed.match(/(?:seq|sequence)[=_-]?(\d+)/i)?.[1] ?? trimmed.match(/^(\d+)$/)?.[1];
        if (match) {
            const n = parseStrictBaseSequence(match);
            if (n !== null) return { status: 'ok', value: n };
        }
        return { status: 'invalid' };
    }
    if (body && typeof body === 'object' && body !== null && 'base_sequence' in body) {
        const n = parseStrictBaseSequence((body as { base_sequence?: unknown }).base_sequence);
        if (n === null) return { status: 'invalid' };
        return { status: 'ok', value: n };
    }
    return { status: 'missing' };
}
