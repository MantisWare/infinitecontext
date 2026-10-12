import type { ApiConfig, DatabaseProvider } from './types';

// =============================================================================
// buildApiConfig — runtime-agnostic, no Node.js deps
// =============================================================================

import { MissingConfigError, requireEnv } from './runtime-config';

function requireFrom(env: Record<string, string | undefined>, name: string): string {
    try {
        return requireEnv(env, name);
    } catch (error) {
        if (error instanceof MissingConfigError) throw error;
        throw new MissingConfigError(name);
    }
}

function resolveProvider(env: Record<string, string | undefined>): DatabaseProvider {
    const value = String(env.DATABASE_PROVIDER ?? '').trim().toLowerCase();
    if (value === 'postgres' || value === 'supabase') return value;
    throw new MissingConfigError('DATABASE_PROVIDER', '(expected "postgres" or "supabase")');
}

export function buildApiConfig(env: Record<string, string | undefined>): ApiConfig {
    const provider = resolveProvider(env);
    const adminKey = requireFrom(env, 'INFINITECONTEXT_ADMIN_KEY');

    if (provider === 'postgres') {
        return {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: requireFrom(env, 'DATABASE_URL'),
            INFINITECONTEXT_ADMIN_KEY: adminKey,
        };
    }

    return {
        DATABASE_PROVIDER: 'supabase',
        SUPABASE_URL: requireFrom(env, 'SUPABASE_URL'),
        SUPABASE_SERVICE_ROLE_KEY: requireFrom(env, 'SUPABASE_SERVICE_ROLE_KEY'),
        INFINITECONTEXT_ADMIN_KEY: adminKey,
    };
}
