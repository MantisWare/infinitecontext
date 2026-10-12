import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/stdio.ts'],
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    clean: true,
    dts: false,
    outExtension: () => ({ js: '.js' }),
});
