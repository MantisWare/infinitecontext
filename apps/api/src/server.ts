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
const mailer = authConfig ? await resolveMailer(process.env, 'node') : undefined;
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
await warnIfMailMisconfigured(process.env, 'node');

serve({ fetch: app.fetch, port });

console.log(`InfiniteContext API listening on http://127.0.0.1:${port}`);
