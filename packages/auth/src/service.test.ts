import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '@infinitecontext/core/testing';

import { createMockGoogleOAuthClient } from './google-oauth';
import { AuthService } from './service';
import { MemoryAuthRepository } from './testing/memory-auth-repository';

const config = {
    jwtSecret: 'test-jwt-secret-value-1234567890',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604800,
    publicBaseUrl: 'http://127.0.0.1:8787',
};

describe('AuthService', () => {
    it('creates a dedicated project per user', async () => {
        const authRepo = new MemoryAuthRepository();
        const storage = new MemoryStorage();
        const service = new AuthService({
            authRepo,
            storage,
            config,
            mailer: { async sendVerificationEmail() {}, async sendPasswordResetEmail() {} },
        });

        const { user, tokens } = await service.registerWithPassword({
            email: 'user@example.com',
            password: 'password1234',
        });
        assert.ok(user.id);
        assert.ok(tokens.accessToken);

        const projectId = await authRepo.findProjectIdByUserId(user.id);
        assert.ok(projectId);
    });

    it('registers Google users without auth password hash', async () => {
        const authRepo = new MemoryAuthRepository();
        const storage = new MemoryStorage();
        const service = new AuthService({
            authRepo,
            storage,
            config,
            mailer: { async sendVerificationEmail() {}, async sendPasswordResetEmail() {} },
            google: createMockGoogleOAuthClient(),
        });

        const started = await service.startGoogleDeviceFlow();
        const result = await service.pollGoogleDeviceFlow(started.deviceCode);
        assert.equal(result.status, 'complete');
        if (result.status !== 'complete') return;
        assert.equal(result.user.password_hash, null);
        assert.ok(result.tokens.refreshToken);
    });
});
