import type { SyncRepository, TransactionalSyncRepository } from '@infinitecontext/core/sync';

export function asTransactionalSyncRepository(
    syncRepo: SyncRepository | null | undefined,
): TransactionalSyncRepository | null {
    if (!syncRepo) return null;
    if (typeof (syncRepo as TransactionalSyncRepository).runStorageTransaction !== 'function') {
        return null;
    }
    return syncRepo as TransactionalSyncRepository;
}
