import { serve } from '@hono/node-server';

import { buildAuthRuntimeConfig } from '@infinitecontext/auth';

import { resolveMailer } from './auth/mailer';
import { createApp } from './app';
import { getApiConfig } from './config.node';
import { logStartupConfigSummary, warnIfJwtSecretMissing, warnIfMailMisconfigured } from './runtime-config';
import { createStorageAdapter } from '@infinitecontext/storage';
import { createAuthRepository } from '@infinitecontext/storage/auth';

// -- Node.js entrypoint -------------------------------------------------------

const config = getApiConfig();
warnIfJwtSecretMissing(process.env);
const storage = createStorageAdapter(config);
const authConfig = buildAuthRuntimeConfig(process.env);
const authRepo = authConfig ? createAuthRepository(config) : undefined;
await warnIfMailMisconfigured(process.env, 'node');
let mailer;
if (authConfig) {
    try {
        mailer = await resolveMailer(process.env, 'node');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
            `[infinitecontext-api] FATAL: account auth is enabled but mailer is not configured (${message}). ` +
                'Configure SMTP/Resend, or set INFINITECONTEXT_ALLOW_CONSOLE_MAILER=true in development.',
        );
        process.exit(1);
    }
}
const trustProxy = String(process.env.INFINITECONTEXT_TRUSTED_PROXY ?? '').trim() === 'true';
const app = createApp({
    config,
    storage,
    authConfig,
    authRepo,
    mailer,
    clientIpOptions: { trustProxy, runtime: 'node' },
    runtimeEnv: process.env,
});
const port = Number(process.env.PORT ?? 8787);

logStartupConfigSummary(process.env);

serve({ fetch: app.fetch, port });

console.log(`InfiniteContext API listening on http://127.0.0.1:${port}`);
