import { UPDATE_RETRY_ATTEMPTS, updateErrorCode } from '@infinitecontext/core';
import type { SyncStorageTransactionContext, TransactionalSyncRepository } from '@infinitecontext/core/sync';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bounded retries for Postgres serialization failures; each attempt is one rolled-back or committed tx. */
export async function runStorageTransactionWithRetry<T>(
    txRepo: TransactionalSyncRepository,
    fn: (ctx: SyncStorageTransactionContext) => Promise<T>,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < UPDATE_RETRY_ATTEMPTS; attempt += 1) {
        try {
            return await txRepo.runStorageTransaction(fn);
        } catch (error) {
            lastError = error;
            if (updateErrorCode(error) !== 'conflict') {
                throw error;
            }
            await sleep(5 * (attempt + 1));
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Concurrent storage transaction retries exhausted');
}
