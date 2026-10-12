import { generateClientNodeId, isClientNodeId } from '@infinitecontext/crypto';
import type { SyncRepository } from '@infinitecontext/core/sync';

import { recordSyncChange } from './record-change';
import type { HttpContext } from '../types/http';
import type { AuthRepository } from '@infinitecontext/auth';

export async function syncSessionMeta(c: HttpContext, authRepo: AuthRepository | null | undefined) {
    const auth = c.get('auth');
    if (!authRepo) return null;
    if (auth.kind === 'user_session') {
        const session = await authRepo.findSessionById(auth.sessionId);
        return {
            userId: auth.userId,
            deviceId: session?.device_id ?? null,
        };
    }
    if (auth.kind === 'api_key') {
        const userId = await authRepo.findUserIdByProjectId(auth.projectId);
        if (!userId) return null;
        return { userId, deviceId: null };
    }
    return null;
}

export function extractAppendClientIds(body: unknown): string[] {
    const items = Array.isArray(body) ? body : [body];
    const ids: string[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string' && isClientNodeId(id)) ids.push(id);
    }
    return ids;
}

export async function recordContextCreateChange(
    syncRepo: SyncRepository | null,
    syncMeta: { userId: number; deviceId: string | null },
    body: unknown,
    result: { id: string; metadata: Record<string, unknown>; created_at: string },
) {
    const isFork = Boolean(body && typeof body === 'object' && 'from' in (body as object) && (body as { from?: string }).from);
    await recordSyncChange(syncRepo, {
        userId: syncMeta.userId,
        op: isFork ? 'context_fork' : 'context_create',
        contextId: result.id,
        payload: {
            context_id: result.id,
            metadata: result.metadata,
            created_at: result.created_at,
            ...(body && typeof body === 'object' ? body : {}),
        },
        deviceId: syncMeta.deviceId,
    });
}

export async function recordMessageAppendChanges(
    syncRepo: SyncRepository | null,
    syncMeta: { userId: number; deviceId: string | null },
    contextId: string,
    body: unknown,
    result: { data: unknown[]; version: number },
) {
    const clientIds = extractAppendClientIds(body);
    const ids = clientIds.length > 0 ? clientIds : [generateClientNodeId()];
    for (const clientId of ids) {
        await recordSyncChange(syncRepo, {
            userId: syncMeta.userId,
            op: 'message_append',
            contextId,
            clientId,
            payload: {
                context_id: contextId,
                data: result.data,
                version: result.version,
                batch: ids.length > 1,
            },
            deviceId: syncMeta.deviceId,
        });
    }
}

export async function recordGenericSyncChange(
    syncRepo: SyncRepository | null,
    syncMeta: { userId: number; deviceId: string | null },
    input: {
        op: string;
        contextId: string | null;
        payload: Record<string, unknown>;
        clientId?: string;
    },
) {
    await recordSyncChange(syncRepo, {
        userId: syncMeta.userId,
        op: input.op,
        contextId: input.contextId,
        clientId: input.clientId,
        payload: input.payload,
        deviceId: syncMeta.deviceId,
    });
}
