import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMockGoogleOAuthClient } from '@infinitecontext/auth';
import { computeDekProof, createVaultCryptoMaterial, rewrapDekWithNewPassphrase } from '@infinitecontext/crypto';
import { MemoryAuthRepository } from '@infinitecontext/auth/testing';
import { MemoryStorage } from '@infinitecontext/core/testing';

import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

const TEST_AUTH_CONFIG = {
    jwtSecret: 'test-jwt-secret-must-be-at-least-32-bytes-long',
    jwtIssuer: 'http://127.0.0.1:8787',
    jwtAudience: 'infinitecontext-api',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 60 * 60 * 24 * 7,
    publicBaseUrl: 'http://127.0.0.1:8787',
};

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
};

async function setupVaultApp() {
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
        return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    }

    const register = await json('POST', '/auth/register', {
        email: 'vault@example.com',
        password: 'password123',
    });
    const accessToken = String(register.body.access_token ?? '');

    return { json, accessToken };
}

describe('vault crypto metadata API', () => {
    it('initializes crypto blobs and allows passphrase re-wrap', async () => {
        const { json, accessToken } = await setupVaultApp();
        const material = await createVaultCryptoMaterial('vault-passphrase1');

        const before = await json('GET', '/auth/crypto', undefined, accessToken);
        assert.equal(before.body.initialized, false);

        const init = await json(
            'PUT',
            '/auth/crypto',
            {
                kdf_salt: Buffer.from(material.kdfSalt).toString('base64'),
                kdf_params: material.kdfParams,
                wrapped_dek: Buffer.from(material.wrappedDekPassphrase).toString('base64'),
                wrapped_dek_recovery: Buffer.from(material.wrappedDekRecovery).toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                dek_version: material.dekVersion,
                vault_passphrase_required: false,
            },
            accessToken,
        );
        assert.equal(init.res.status, 200);
        assert.equal(init.body.initialized, true);
        assert.ok(init.body.wrapped_dek);
        assert.ok(init.body.wrapped_dek_recovery);

        const newWrap = await rewrapDekWithNewPassphrase({
            dek: material.dek,
            newPassphrase: 'new-vault-pass-12',
            kdfSalt: material.kdfSalt,
        });
        const patch = await json(
            'PATCH',
            '/auth/crypto',
            {
                wrapped_dek: Buffer.from(newWrap.wrappedDek).toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                expected_wrapped_dek: init.body.wrapped_dek,
                expected_wrapped_dek_recovery: init.body.wrapped_dek_recovery,
            },
            accessToken,
        );
        assert.equal(patch.res.status, 200);
        assert.notEqual(patch.body.wrapped_dek, init.body.wrapped_dek);

        const garbage = await json(
            'PATCH',
            '/auth/crypto',
            {
                wrapped_dek: Buffer.from('not-a-valid-wrap').toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                expected_wrapped_dek: patch.body.wrapped_dek,
                expected_wrapped_dek_recovery: patch.body.wrapped_dek_recovery,
            },
            accessToken,
        );
        assert.equal(garbage.res.status, 400);
    });
});
