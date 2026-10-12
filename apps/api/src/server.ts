import { serve } from '@hono/node-server';

import { buildAuthRuntimeConfig } from '@infinitecontext/auth';

import { resolveMailer } from './auth/mailer';
import { createApp } from './app';
import { getApiConfig } from './config.node';
import { createAuthRepository, createStorageAdapter } from '@infinitecontext/storage';

// -- Node.js entrypoint -------------------------------------------------------

const config = getApiConfig();
const storage = createStorageAdapter(config);
const authConfig = buildAuthRuntimeConfig(process.env);
const authRepo = authConfig ? createAuthRepository(config) : undefined;
const mailer = authConfig ? await resolveMailer(process.env, 'node') : undefined;
const app = createApp({ config, storage, authConfig, authRepo, mailer });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });

console.log(`InfiniteContext API listening on http://127.0.0.1:${port}`);
