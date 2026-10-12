export function appendErrorCode(error: unknown): 'conflict' | 'internal' | null {
    if (!error || typeof error !== 'object') return null;
    const rec = error as Record<string, unknown>;
    const code = rec.code ?? (rec.cause as Record<string, unknown> | undefined)?.code;
    if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') return 'conflict';
    if (code === '40001') return 'conflict';
    const message = String(rec.message ?? '');
    if (message.includes('unique constraint') || message.includes('UNIQUE constraint failed')) return 'conflict';
    if (message.includes('could not serialize access') || message.includes('serialization failure')) return 'conflict';
    return null;
}
