import { Hono } from 'hono';

import {
    createAuthRateLimiters,
    type AuthRepository,
    type AuthRuntimeConfig,
    type GoogleOAuthClient,
    type Mailer,
} from '@infinitecontext/auth';
import type { StorageAdapter } from '@infinitecontext/core';

import { type ClientIpReaderOptions } from './auth/rate-limit';
import { registerAuthRoutes, resolveGoogleClient } from './auth/routes';
import { registerVaultRoutes } from './auth/vault-routes';
import type { KeyCache } from './cache/types';
import { registerAuthMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { databaseMiddleware } from './middleware/database';
import { registerContextRoutes } from './routes/contexts';
import { registerKeyRoutes } from './routes/keys';
import { registerMcpRoutes } from './routes/mcp';
import { registerHealthRoutes } from './routes/health';
import { registerSyncRoutes } from './routes/sync';
import { registerRootRoutes } from './routes/root';
import { createSyncRateLimiters, type SyncRateLimiters } from './sync/rate-limit';
import { createSyncRepository, DrizzleAdapter } from '@infinitecontext/storage';
import type { ApiConfig } from './types/api';
import type { AppEnv } from './types/http';

// -- app factory --------------------------------------------------------------

export type AppOptions = {
    config: ApiConfig;
    storage: StorageAdapter;
    keyCache?: KeyCache;
    authConfig?: AuthRuntimeConfig | null;
    authRepo?: AuthRepository;
    mailer?: Mailer;
    googleOAuth?: GoogleOAuthClient;
    clientIpOptions?: ClientIpReaderOptions;
    /** Process env for public /health/config (no secrets in response). */
    runtimeEnv?: Record<string, string | undefined>;
    syncRateLimiters?: SyncRateLimiters;
};

export function createApp(options: AppOptions) {
    const app = new Hono<AppEnv>();

    app.use('*', corsMiddleware);
    app.use('*', databaseMiddleware(options.storage, options.config));

    registerAuthMiddleware(app, {
        keyCache: options.keyCache,
        authConfig: options.authConfig ?? null,
        authRepo: options.authRepo ?? null,
    });
    registerRootRoutes(app);
    registerHealthRoutes(app, options.runtimeEnv ?? {}, Boolean(options.keyCache));
    registerKeyRoutes(app);
    const syncRepo =
        options.authConfig && options.authRepo && options.storage instanceof DrizzleAdapter
            ? createSyncRepository(options.config)
            : null;
    registerContextRoutes(app, { authRepo: options.authRepo ?? null, syncRepo });
    registerMcpRoutes(app);

    if (options.authConfig && options.authRepo) {
        if (!options.mailer) {
            throw new Error('Auth routes require a configured mailer');
        }
        const google = options.googleOAuth ?? resolveGoogleClient(options.authConfig);
        registerAuthRoutes(app, {
            authConfig: options.authConfig,
            authRepo: options.authRepo,
            storage: options.storage,
            mailer: options.mailer,
            google,
            rateLimiters: createAuthRateLimiters(),
            clientIpOptions: options.clientIpOptions ?? { trustProxy: false, runtime: 'node' },
        });
        registerVaultRoutes(app, options.authRepo);
        registerSyncRoutes(app, {
            syncRepo,
            authRepo: options.authRepo,
            rateLimiters: options.syncRateLimiters ?? createSyncRateLimiters(),
        });
    }

    return app;
}
