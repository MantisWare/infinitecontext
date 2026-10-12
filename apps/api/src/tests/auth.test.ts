import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMockGoogleOAuthClient } from '@infinitecontext/auth';
import { MemoryAuthRepository } from '@infinitecontext/auth/testing';
import { generateKey, hashKey, KEY_PREFIX_LEN } from '@infinitecontext/core';
import { MemoryStorage } from '@infinitecontext/core/testing';

import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

const TEST_AUTH_CONFIG = {
    jwtSecret: 'test-jwt-secret-should-be-long-enough',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 60 * 60 * 24 * 7,
    publicBaseUrl: 'http://127.0.0.1:8787',
};

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
};

async function setupAuthApp() {
    const storage = new MemoryStorage();
    const authRepo = new MemoryAuthRepository();
    const app = createApp({
        config: TEST_CONFIG,
        storage,
        authConfig: TEST_AUTH_CONFIG,
        authRepo,
        googleOAuth: createMockGoogleOAuthClient(),
        mailer: {
            async sendVerificationEmail() {},
            async sendPasswordResetEmail() {},
        },
    });

    async function json(method: string, path: string, body?: unknown, token?: string) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await app.request(`http://localhost${path}`, init);
        const text = await res.text();
        let parsed: Record<string, unknown> = {};
        if (text) {
            try {
                parsed = JSON.parse(text) as Record<string, unknown>;
            } catch {
                parsed = { raw: text };
            }
        }
        return { res, body: parsed };
    }

    return { app, storage, authRepo, json };
}

describe('account auth', () => {
    it('registers, logs in, refreshes, and accesses contexts with JWT', async () => {
        const { json } = await setupAuthApp();

        const register = await json('POST', '/auth/register', {
            email: 'alice@example.com',
            password: 'password123',
            device_id: 'cli-test',
        });
        assert.equal(register.res.status, 200);
        assert.ok(register.body.access_token);
        assert.ok(register.body.refresh_token);

        const login = await json('POST', '/auth/login', {
            email: 'alice@example.com',
            password: 'password123',
        });
        assert.equal(login.res.status, 200);

        const accessToken = String(login.body.access_token);
        const refreshToken = String(login.body.refresh_token);

        const me = await json('GET', '/auth/me', undefined, accessToken);
        assert.equal(me.res.status, 200);
        assert.equal(me.body.email, 'alice@example.com');

        const create = await json('POST', '/contexts', { metadata: { source: 'test' } }, accessToken);
        assert.equal(create.res.status, 201);
        assert.ok(create.body.id);

        const refreshed = await json('POST', '/auth/refresh', { refresh_token: refreshToken });
        assert.equal(refreshed.res.status, 200);
        assert.ok(refreshed.body.access_token);

        const logout = await json('POST', '/auth/logout', { refresh_token: refreshToken });
        assert.equal(logout.res.status, 200);

        const refreshAfterLogout = await json('POST', '/auth/refresh', { refresh_token: refreshToken });
        assert.equal(refreshAfterLogout.res.status, 401);
    });

    it('still accepts ic_ API keys alongside JWT auth', async () => {
        const { storage, json } = await setupAuthApp();
        const project = await storage.insertProject('legacy');
        const apiKey = generateKey('test');
        const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
        const hash = await hashKey(apiKey);
        await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });

        const create = await json('POST', '/contexts', {}, apiKey);
        assert.equal(create.res.status, 201);
    });

    it('completes mocked Google device flow', async () => {
        const { json } = await setupAuthApp();

        const start = await json('POST', '/auth/oauth/google/device/start');
        assert.equal(start.res.status, 200);
        const deviceCode = String(start.body.device_code);

        const poll = await json('POST', '/auth/oauth/google/device/poll', { device_code: deviceCode });
        assert.equal(poll.res.status, 200);
        assert.equal(poll.body.status, 'complete');
        assert.ok(poll.body.access_token);

        const accessToken = String(poll.body.access_token);
        const me = await json('GET', '/auth/me', undefined, accessToken);
        assert.equal(me.res.status, 200);
        assert.equal(me.body.email, 'test@example.com');
    });

    it('verifies email and resets password via opaque tokens', async () => {
        const { json, authRepo } = await setupAuthApp();

        const register = await json('POST', '/auth/register', {
            email: 'bob@example.com',
            password: 'oldpassword1',
        });
        assert.equal(register.res.status, 200);

        const user = await authRepo.findUserByEmail('bob@example.com');
        assert.ok(user);
        assert.equal(user!.email_verified_at, null);

        // capture verification token from in-memory mailer substitute via direct service is hard;
        // use request-password-reset + manual token insert is easier for verify — call verify through repo token
        const tokens = await authRepo.insertAuthToken({
            userId: user!.id,
            tokenHash: await (await import('@infinitecontext/auth')).hashOpaqueToken('manual-verify-token'),
            kind: 'email_verify',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        assert.ok(tokens.id);

        const verify = await json('POST', '/auth/verify-email', { token: 'manual-verify-token' });
        assert.equal(verify.res.status, 200);
        const updated = await authRepo.findUserById(user!.id);
        assert.ok(updated?.email_verified_at);

        const resetToken = 'manual-reset-token';
        await authRepo.insertAuthToken({
            userId: user!.id,
            tokenHash: await (await import('@infinitecontext/auth')).hashOpaqueToken(resetToken),
            kind: 'password_reset',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });

        const reset = await json('POST', '/auth/reset-password', {
            token: resetToken,
            password: 'newpassword2',
        });
        assert.equal(reset.res.status, 200);

        const badLogin = await json('POST', '/auth/login', {
            email: 'bob@example.com',
            password: 'oldpassword1',
        });
        assert.equal(badLogin.res.status, 401);

        const goodLogin = await json('POST', '/auth/login', {
            email: 'bob@example.com',
            password: 'newpassword2',
        });
        assert.equal(goodLogin.res.status, 200);
    });
});
