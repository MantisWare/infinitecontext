import {
    loadOrderedContextMessages,
    resolveSelectorsToClientNodeIds,
    type StorageAdapter,
} from '@infinitecontext/core';
import { hasMessageClientMutationSince } from '@infinitecontext/core/sync';
import type { SyncRepository } from '@infinitecontext/core/sync';

export async function resolveDeleteTargetClientIds(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    ids: (string | number)[],
) {
    const ordered = await loadOrderedContextMessages(storage, projectId, contextId);
    if (!ordered.ok) return ordered;
    return resolveSelectorsToClientNodeIds(ordered.data, ids);
}

export async function assertRestMessageDeleteNotStale(
    syncRepo: SyncRepository,
    userId: number,
    contextId: string,
    baseSequence: number,
    targetClientIds: string[],
): Promise<boolean> {
    return hasMessageClientMutationSince(syncRepo, userId, contextId, baseSequence, targetClientIds);
}
