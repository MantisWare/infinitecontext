import type { SyncRepository } from '@infinitecontext/core/sync';
import { generateClientNodeId } from '@infinitecontext/crypto';

export async function recordSyncChange(
    syncRepo: SyncRepository | null | undefined,
    input: {
        userId: number;
        op: string;
        contextId: string | null;
        clientId?: string;
        payload: Record<string, unknown>;
        deviceId?: string | null;
    },
): Promise<number | null> {
    if (!syncRepo) return null;
    const clientId = input.clientId ?? generateClientNodeId();
    const existing = await syncRepo.findChangeByClientId(input.userId, clientId);
    if (existing) return existing.sequence;
    return syncRepo.appendChange({
        userId: input.userId,
        op: input.op,
        contextId: input.contextId,
        clientId,
        payload: input.payload,
        deviceId: input.deviceId ?? null,
    });
}
