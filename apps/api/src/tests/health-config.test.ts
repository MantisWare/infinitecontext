import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '@infinitecontext/core/testing';

import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
};

describe('health routes', () => {
    it('GET /health/config returns booleans only', async () => {
        const env = {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: 'postgres://test',
            INFINITECONTEXT_JWT_SECRET: 'test-jwt-secret-must-be-at-least-32-bytes-long',
            INFINITECONTEXT_MAIL_PROVIDER: 'smtp',
            INFINITECONTEXT_SMTP_HOST: '127.0.0.1',
        };

        const app = createApp({
            config: TEST_CONFIG,
            storage: new MemoryStorage(),
            runtimeEnv: env,
        });

        const res = await app.request('http://localhost/health/config');
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(typeof body.database, 'boolean');
        assert.equal(typeof body.account_auth, 'boolean');
        assert.equal(typeof body.google_oauth, 'boolean');
        assert.equal(body.google_oauth, false);
        for (const value of Object.values(body)) {
            assert.equal(typeof value, 'boolean');
        }
    });

    it('GET /auth/providers reflects Google config', async () => {
        const env = {
            INFINITECONTEXT_JWT_SECRET: 'test-jwt-secret-must-be-at-least-32-bytes-long',
            INFINITECONTEXT_GOOGLE_CLIENT_ID: 'id',
            INFINITECONTEXT_GOOGLE_CLIENT_SECRET: 'secret',
        };

        const app = createApp({
            config: TEST_CONFIG,
            storage: new MemoryStorage(),
            runtimeEnv: env,
        });

        const res = await app.request('http://localhost/auth/providers');
        assert.equal(res.status, 200);
        const body = (await res.json()) as { password: boolean; google: boolean };
        assert.equal(body.password, true);
        assert.equal(body.google, true);
    });
});
