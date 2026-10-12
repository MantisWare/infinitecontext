import { Hono } from 'hono';

import { createConsoleMailer } from '@infinitecontext/auth';
import type { AuthRepository, AuthRuntimeConfig, GoogleOAuthClient, Mailer } from '@infinitecontext/auth';
import type { StorageAdapter } from '@infinitecontext/core';

import { registerAuthRoutes, resolveGoogleClient } from './auth/routes';
import type { KeyCache } from './cache/types';
import { registerAuthMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { databaseMiddleware } from './middleware/database';
import { registerContextRoutes } from './routes/contexts';
import { registerKeyRoutes } from './routes/keys';
import { registerMcpRoutes } from './routes/mcp';
import { registerRootRoutes } from './routes/root';
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
};

export function createApp(options: AppOptions) {
    const app = new Hono<AppEnv>();

    app.use('*', corsMiddleware);
    app.use('*', databaseMiddleware(options.storage, options.config));

    registerAuthMiddleware(app, { keyCache: options.keyCache, authConfig: options.authConfig ?? null });
    registerRootRoutes(app);
    registerKeyRoutes(app);
    registerContextRoutes(app);
    registerMcpRoutes(app);

    if (options.authConfig && options.authRepo) {
        const mailer = options.mailer ?? createConsoleMailer();
        const google = options.googleOAuth ?? resolveGoogleClient(options.authConfig);
        registerAuthRoutes(app, {
            authConfig: options.authConfig,
            authRepo: options.authRepo,
            storage: options.storage,
            mailer,
            google,
        });
    }

    return app;
}
