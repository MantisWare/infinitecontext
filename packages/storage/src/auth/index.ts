import type { AuthRepository } from '@infinitecontext/auth';

import { createDbClient, type ApiDb } from '../db';
import { DrizzleAuthRepository } from './drizzle-auth-repository';
import { SupabaseAuthRepository } from './supabase-auth-repository';

export type AuthStorageConfig =
    | { DATABASE_PROVIDER: 'postgres'; DATABASE_URL: string }
    | { DATABASE_PROVIDER: 'supabase'; SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string };

export function createAuthRepository(config: AuthStorageConfig, existingDb?: ApiDb): AuthRepository {
    if (config.DATABASE_PROVIDER === 'supabase') {
        return new SupabaseAuthRepository(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    }
    const db = existingDb ?? createDbClient(config.DATABASE_URL);
    return new DrizzleAuthRepository(db);
}

export { DrizzleAuthRepository } from './drizzle-auth-repository';
export { SupabaseAuthRepository } from './supabase-auth-repository';
