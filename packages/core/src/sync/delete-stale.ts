import type { SyncRepository } from './repository';

export async function hasMessageClientMutationSince(
    repo: SyncRepository,
    userId: number,
    contextId: string,
    sinceSequence: number,
    clientNodeIds: string[],
): Promise<boolean> {
    if (clientNodeIds.length === 0) return false;
    return repo.hasMessageClientMutationSince(userId, contextId, sinceSequence, clientNodeIds);
}
