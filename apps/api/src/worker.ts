import { buildAuthRuntimeConfig, type Mailer } from '@infinitecontext/auth';

import { resolveMailer } from './auth/mailer';
import { KvKeyCache } from './cache/kv';
import { buildApiConfig } from './config';
import { createApp } from './app';
import { createAuthRepository } from '@infinitecontext/storage/auth';
import { SupabaseAdapter } from '@infinitecontext/storage/supabase';

// =============================================================================
// CF WORKERS ENTRYPOINT
// =============================================================================

type Env = {
    DATABASE_PROVIDER: string;
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    INFINITECONTEXT_ADMIN_KEY: string;
    INFINITECONTEXT_JWT_SECRET?: string;
    INFINITECONTEXT_GOOGLE_CLIENT_ID?: string;
    INFINITECONTEXT_GOOGLE_CLIENT_SECRET?: string;
    INFINITECONTEXT_AUTH_PUBLIC_BASE_URL?: string;
    INFINITECONTEXT_ACCESS_TOKEN_TTL_SEC?: string;
    INFINITECONTEXT_REFRESH_TOKEN_TTL_SEC?: string;
    INFINITECONTEXT_MAIL_PROVIDER?: string;
    INFINITECONTEXT_RESEND_API_KEY?: string;
    INFINITECONTEXT_MAIL_FROM?: string;
    INFINITECONTEXT_ALLOW_CONSOLE_MAILER?: string;
    INFINITECONTEXT_TRUSTED_PROXY?: string;
    INFINITECONTEXT_ENV?: string;
    NODE_ENV?: string;
    INFINITECONTEXT_API_KEYS_CACHE?: KVNamespace;
};

// cached per worker instance
let app: ReturnType<typeof createApp> | null = null;
let mailerPromise: Promise<Mailer | undefined> | null = null;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (!app) {
            const config = buildApiConfig(env as unknown as Record<string, string | undefined>);
            if (config.DATABASE_PROVIDER !== 'supabase') {
                throw new Error('CF Workers only supports Supabase storage');
            }
            const storage = new SupabaseAdapter(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

            const keyCache = env.INFINITECONTEXT_API_KEYS_CACHE
                ? new KvKeyCache(env.INFINITECONTEXT_API_KEYS_CACHE)
                : undefined;

            const authConfig = buildAuthRuntimeConfig(env as unknown as Record<string, string | undefined>);
            const authRepo = authConfig ? createAuthRepository(config) : undefined;
            mailerPromise ??= authConfig ? resolveMailer(env as unknown as Record<string, string | undefined>, 'worker') : Promise.resolve(undefined);
            const mailer = await mailerPromise;

            const trustProxy = String(env.INFINITECONTEXT_TRUSTED_PROXY ?? '').trim() === 'true';
            app = createApp({
                config,
                storage,
                keyCache,
                authConfig,
                authRepo,
                mailer,
                clientIpOptions: { trustProxy, runtime: 'worker' },
                runtimeEnv: env as unknown as Record<string, string | undefined>,
            });
        }

        return app.fetch(request);
    },
};
