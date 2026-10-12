import { serve } from '@hono/node-server';

import { createApp } from './app';
import { getApiConfig } from './config.node';
import { createStorageAdapter } from '@infinitecontext/storage';

// -- Node.js entrypoint -------------------------------------------------------

const config = getApiConfig();
const storage = createStorageAdapter(config);
const app = createApp({ config, storage });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });

console.log(`InfiniteContext API listening on http://127.0.0.1:${port}`);
