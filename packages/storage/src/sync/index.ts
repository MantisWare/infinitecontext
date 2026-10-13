import { createDbClient } from '../db';
import type { StorageConfig } from '../index';
import { DrizzleSyncRepository } from './drizzle-sync-repository';

export { DrizzleSyncRepository } from './drizzle-sync-repository';

export function createSyncRepository(config: StorageConfig) {
    if (config.DATABASE_PROVIDER !== 'postgres') {
        return null;
    }
    return new DrizzleSyncRepository(createDbClient(config.DATABASE_URL));
}
