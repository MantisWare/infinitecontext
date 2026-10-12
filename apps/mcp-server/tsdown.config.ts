import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsSdkRoot = path.resolve(__dirname, '../js-sdk');

export default defineConfig({
    entry: ['src/stdio.ts'],
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    clean: true,
    dts: false,
    banner: {
        js: '#!/usr/bin/env node',
    },
    noExternal: [/^infinitecontext/, /^@infinitecontext\//, /^zod/, /^@modelcontextprotocol\//],
    alias: {
        infinitecontext: path.join(jsSdkRoot, 'dist/index.mjs'),
        'infinitecontext/credentials': path.join(jsSdkRoot, 'lib/credentials.mjs'),
        'infinitecontext/lib/client-config.mjs': path.join(jsSdkRoot, 'lib/client-config.mjs'),
    },
    outExtension: () => ({ js: '.js' }),
});
