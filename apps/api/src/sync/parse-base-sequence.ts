import type { HttpContext } from '../types/http';

export function parseBaseSequence(c: HttpContext, body: unknown): number | null {
    const header =
        c.req.header('X-IC-Base-Sequence') ??
        c.req.header('X-InfiniteContext-Base-Sequence') ??
        c.req.header('If-Match');
    if (header) {
        const trimmed = header.trim();
        const direct = Number(trimmed);
        if (Number.isFinite(direct) && direct >= 0) return direct;
        const match = trimmed.match(/(?:seq|sequence)[=_-]?(\d+)/i)?.[1] ?? trimmed.match(/^(\d+)$/)?.[1];
        if (match) {
            const n = Number(match);
            if (Number.isFinite(n) && n >= 0) return n;
        }
    }
    if (body && typeof body === 'object' && body !== null && 'base_sequence' in body) {
        const n = Number((body as { base_sequence?: unknown }).base_sequence);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
}
