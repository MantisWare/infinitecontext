import { MemoryRateLimiter } from '@infinitecontext/auth';
import { createMockGoogleOAuthClient } from '@infinitecontext/auth';
import { createAuthRepository, createStorageAdapter } from '@infinitecontext/storage';

import { createApp } from '../../app';
import type { ApiConfig } from '../../types/api';

export const TEST_AUTH_CONFIG = {
    jwtSecret: 'test-jwt-secret-must-be-at-least-32-bytes-long',
    jwtIssuer: 'http://127.0.0.1:8787',
    jwtAudience: 'infinitecontext-api',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 60 * 60 * 24 * 7,
    publicBaseUrl: 'http://127.0.0.1:8787',
};

export function liveDatabaseUrl(): string {
    const url = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;
    if (!url) {
        throw new Error('SYNC_E2E_DATABASE_URL or VAULT_E2E_DATABASE_URL is required');
    }
    return url;
}

export function testRateLimiters() {
    return {
        pullByUser: new MemoryRateLimiter(5_000_000, 60_000),
        pushByUser: new MemoryRateLimiter(5_000_000, 60_000),
    };
}

export function createLivePostgresApp() {
    const config: ApiConfig = {
        DATABASE_PROVIDER: 'postgres',
        DATABASE_URL: liveDatabaseUrl(),
        INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
    };
    const storage = createStorageAdapter(config);
    const authRepo = createAuthRepository(config);
    const app = createApp({
        config,
        storage,
        authConfig: TEST_AUTH_CONFIG,
        authRepo,
        googleOAuth: createMockGoogleOAuthClient(),
        mailer: {
            async sendVerificationEmail() {},
            async sendPasswordResetEmail() {},
        },
        syncRateLimiters: testRateLimiters(),
    });

    async function json(
        method: string,
        urlPath: string,
        body?: unknown,
        token?: string,
        extraHeaders?: Record<string, string>,
    ) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
        if (token) headers.Authorization = `Bearer ${token}`;
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await app.request(`http://127.0.0.1${urlPath}`, init);
        const text = await res.text();
        return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    }

    return { app, config, storage, authRepo, json };
}
