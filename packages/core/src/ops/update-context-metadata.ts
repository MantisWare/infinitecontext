import type { StorageAdapter } from '../storage';
import { err, ok, type Result } from '../result';

function parseUpdatedAt(raw: unknown): number | null {
    if (raw === undefined || raw === null) return null;
    const ms = Date.parse(String(raw));
    return Number.isFinite(ms) ? ms : null;
}

export async function updateContextMetadataLww(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    metadata: Record<string, unknown>,
    updatedAt: string,
): Promise<
    Result<{
        metadata: Record<string, unknown>;
        applied: boolean;
        existing_updated_at?: string;
        incoming_updated_at: string;
    }>
> {
    const incomingMs = parseUpdatedAt(updatedAt);
    if (incomingMs === null) {
        return err('invalid_input', 'updated_at must be a valid ISO timestamp');
    }

    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    const existing = (root.metadata ?? {}) as Record<string, unknown>;
    const existingUpdatedAt = typeof existing.ic_metadata_updated_at === 'string' ? existing.ic_metadata_updated_at : null;
    const existingMs = existingUpdatedAt ? parseUpdatedAt(existingUpdatedAt) : 0;

    if (existingMs !== null && existingMs > incomingMs) {
        return ok({
            metadata: existing,
            applied: false,
            existing_updated_at: existingUpdatedAt ?? undefined,
            incoming_updated_at: updatedAt,
        });
    }

    const merged = {
        ...existing,
        ...metadata,
        ic_metadata_updated_at: updatedAt,
    };

    await storage.updateRootContextMetadata(projectId, contextId, merged);

    return ok({
        metadata: merged,
        applied: true,
        existing_updated_at: existingUpdatedAt ?? undefined,
        incoming_updated_at: updatedAt,
    });
}
