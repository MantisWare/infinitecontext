import type { HttpContext } from '../types/http';

export type ParsedBaseSequence =
    | { status: 'missing' }
    | { status: 'invalid' }
    | { status: 'ok'; value: number };

function parseSequenceNumber(raw: unknown): number | null {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    return n;
}

export function parseBaseSequence(c: HttpContext, body: unknown): ParsedBaseSequence {
    const header =
        c.req.header('X-IC-Base-Sequence') ??
        c.req.header('X-InfiniteContext-Base-Sequence') ??
        c.req.header('If-Match');
    if (header) {
        const trimmed = header.trim();
        const direct = parseSequenceNumber(trimmed);
        if (direct !== null) return { status: 'ok', value: direct };
        const match = trimmed.match(/(?:seq|sequence)[=_-]?(\d+)/i)?.[1] ?? trimmed.match(/^(\d+)$/)?.[1];
        if (match) {
            const n = parseSequenceNumber(match);
            if (n !== null) return { status: 'ok', value: n };
        }
        return { status: 'invalid' };
    }
    if (body && typeof body === 'object' && body !== null && 'base_sequence' in body) {
        const n = parseSequenceNumber((body as { base_sequence?: unknown }).base_sequence);
        if (n === null) return { status: 'invalid' };
        return { status: 'ok', value: n };
    }
    return { status: 'missing' };
}
