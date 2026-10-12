import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '@infinitecontext/core/testing';

import { createMockGoogleOAuthClient } from './google-oauth';
import { AuthService } from './service';
import { hashOpaqueToken, hashRefreshToken } from './tokens';
import { MemoryAuthRepository } from './testing/memory-auth-repository';

const config = {
    jwtSecret: 'test-jwt-secret-value-1234567890123456',
    jwtIssuer: 'http://127.0.0.1:8787',
    jwtAudience: 'infinitecontext-api',
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

    it('rotates refresh tokens and revokes session on reuse', async () => {
        const authRepo = new MemoryAuthRepository();
        const storage = new MemoryStorage();
        const service = new AuthService({
            authRepo,
            storage,
            config,
            mailer: { async sendVerificationEmail() {}, async sendPasswordResetEmail() {} },
        });

        await service.registerWithPassword({ email: 'rotate@example.com', password: 'password1234' });
        const { tokens } = await service.loginWithPassword({
            email: 'rotate@example.com',
            password: 'password1234',
        });

        const firstRefresh = tokens.refreshToken;
        const rotated = await service.refresh(firstRefresh);
        assert.notEqual(rotated.refreshToken, firstRefresh);

        const reusedSession = await authRepo.findSessionByReplacedRefreshTokenHash(await hashRefreshToken(firstRefresh));
        assert.ok(reusedSession);
        reusedSession.refresh_grace_expires_at = new Date(Date.now() - 1000).toISOString();

        await assert.rejects(() => service.refresh(firstRefresh), /reuse/i);
    });

    it('revokes the session when a refresh token two generations old is replayed', async () => {
        const authRepo = new MemoryAuthRepository();
        const storage = new MemoryStorage();
        const service = new AuthService({
            authRepo,
            storage,
            config,
            mailer: { async sendVerificationEmail() {}, async sendPasswordResetEmail() {} },
        });

        await service.registerWithPassword({ email: 'gen@example.com', password: 'password1234' });
        const { tokens } = await service.loginWithPassword({
            email: 'gen@example.com',
            password: 'password1234',
        });

        const gen0 = tokens.refreshToken;
        const gen1Pair = await service.refresh(gen0);
        await service.refresh(gen1Pair.refreshToken);

        await assert.rejects(() => service.refresh(gen0), /reuse/i);
        const session = await authRepo.findSessionByReplacedRefreshTokenHash(await hashRefreshToken(gen0));
        assert.equal(session, null);
        const priorSession = await authRepo.findSessionByPriorReplacedRefreshTokenHash(await hashRefreshToken(gen0));
        assert.ok(priorSession?.revoked_at);
    });

    it('returns expired for stale Google device flows', async () => {
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
        const hash = await hashOpaqueToken(started.deviceCode);
        const row = await authRepo.findOAuthDeviceFlowByHash(hash);
        assert.ok(row);
        row!.expires_at = new Date(Date.now() - 60_000).toISOString();

        const result = await service.pollGoogleDeviceFlow(started.deviceCode);
        assert.equal(result.status, 'expired');
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
        assert.ok(await hashRefreshToken(result.tokens.refreshToken));
    });
});
