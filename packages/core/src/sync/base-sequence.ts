/** Parse optimistic-sync base: non-negative integers within JS safe integer range only. */
export function parseStrictBaseSequence(raw: unknown): number | null {
    if (typeof raw === 'number') {
        if (!Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) return null;
        return raw;
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        if (trimmed.length > 16) return null;
        const n = Number(trimmed);
        if (!Number.isSafeInteger(n) || n < 0) return null;
        return n;
    }
    return null;
}

export function isBaseSequenceAboveHead(base: number, head: number): boolean {
    return base > head;
}
