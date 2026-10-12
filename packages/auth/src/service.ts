import type { StorageAdapter } from '@infinitecontext/core';

import { signAccessToken } from './jwt';
import { hashAuthPassword, verifyAuthPassword } from './password';
import { generateUserPublicId, generateSessionPublicId } from './public-ids';
import {
    generateOpaqueToken,
    generateRefreshToken,
    hashOpaqueToken,
    hashRefreshToken,
} from './tokens';
import type {
    AuthRepository,
    AuthRuntimeConfig,
    AuthTokenPair,
    Mailer,
    UserRow,
} from './types';
import type { GoogleOAuthClient, GoogleUserInfo } from './google-oauth';

export type AuthServiceDeps = {
    authRepo: AuthRepository;
    storage: StorageAdapter;
    config: AuthRuntimeConfig;
    mailer: Mailer;
    google?: GoogleOAuthClient;
    now?: () => Date;
};

export class AuthService {
    private readonly now: () => Date;

    constructor(private readonly deps: AuthServiceDeps) {
        this.now = deps.now ?? (() => new Date());
    }

    async registerWithPassword(input: {
        email: string;
        password: string;
        deviceId?: string;
        deviceName?: string;
    }): Promise<{ user: UserRow; tokens: AuthTokenPair; verificationToken?: string }> {
        const email = normalizeEmail(input.email);
        if (!email) throw new AuthError('invalid_email', 'Invalid email address');
        if (input.password.length < 8) throw new AuthError('weak_password', 'Password must be at least 8 characters');

        const existing = await this.deps.authRepo.findUserByEmail(email);
        if (existing) throw new AuthError('email_taken', 'Email is already registered');

        const passwordHash = await hashAuthPassword(input.password);
        const user = await this.deps.authRepo.createUser({
            publicId: generateUserPublicId(),
            email,
            passwordHash,
            emailVerifiedAt: null,
        });

        await this.ensureUserProject(user.id);

        const verificationToken = generateOpaqueToken('ic_ev');
        const verifyHash = await hashOpaqueToken(verificationToken);
        const verifyExpires = addSeconds(this.now(), 60 * 60 * 24).toISOString();
        await this.deps.authRepo.insertAuthToken({
            userId: user.id,
            tokenHash: verifyHash,
            kind: 'email_verify',
            expiresAt: verifyExpires,
        });
        const verifyUrl = `${this.deps.config.publicBaseUrl}/auth/verify-email?token=${encodeURIComponent(verificationToken)}`;
        await this.deps.mailer.sendVerificationEmail({ to: email, verifyUrl });

        const tokens = await this.issueSession(user, input.deviceId, input.deviceName);
        return { user, tokens, verificationToken };
    }

    async loginWithPassword(input: {
        email: string;
        password: string;
        deviceId?: string;
        deviceName?: string;
    }): Promise<{ user: UserRow; tokens: AuthTokenPair }> {
        const email = normalizeEmail(input.email);
        const user = email ? await this.deps.authRepo.findUserByEmail(email) : null;
        if (!user?.password_hash) throw new AuthError('invalid_credentials', 'Invalid email or password');

        const ok = await verifyAuthPassword(input.password, user.password_hash);
        if (!ok) throw new AuthError('invalid_credentials', 'Invalid email or password');

        await this.ensureUserProject(user.id);
        const tokens = await this.issueSession(user, input.deviceId, input.deviceName);
        return { user, tokens };
    }

    async refresh(refreshToken: string): Promise<AuthTokenPair> {
        const hash = await hashRefreshToken(refreshToken);
        const session = await this.deps.authRepo.findSessionByRefreshTokenHash(hash);
        if (!session) throw new AuthError('invalid_refresh', 'Invalid refresh token');
        if (session.revoked_at) throw new AuthError('invalid_refresh', 'Session revoked');
        if (Date.parse(session.expires_at) <= this.now().getTime()) {
            throw new AuthError('invalid_refresh', 'Refresh token expired');
        }

        const user = await this.deps.authRepo.findUserById(session.user_id);
        if (!user) throw new AuthError('invalid_refresh', 'User not found');

        await this.deps.authRepo.touchSession(session.id, this.now().toISOString());
        const projectId = await this.ensureUserProject(user.id);
        const access = await signAccessToken(this.deps.config, {
            sub: user.public_id,
            uid: user.id,
            pid: projectId,
            sid: session.id,
        });

        return {
            accessToken: access.token,
            refreshToken,
            accessTokenExpiresAt: access.expiresAt,
            refreshTokenExpiresAt: session.expires_at,
            tokenType: 'Bearer',
        };
    }

    async logout(refreshToken: string): Promise<void> {
        const hash = await hashRefreshToken(refreshToken);
        const session = await this.deps.authRepo.findSessionByRefreshTokenHash(hash);
        if (!session) return;
        await this.deps.authRepo.revokeSession(session.id, this.now().toISOString());
    }

    async verifyEmail(token: string): Promise<void> {
        const hash = await hashOpaqueToken(token);
        const row = await this.deps.authRepo.consumeAuthToken('email_verify', hash, this.now().toISOString());
        if (!row) throw new AuthError('invalid_token', 'Verification link is invalid or expired');
        await this.deps.authRepo.markEmailVerified(row.user_id, this.now().toISOString());
    }

    async requestPasswordReset(email: string): Promise<void> {
        const normalized = normalizeEmail(email);
        if (!normalized) return;
        const user = await this.deps.authRepo.findUserByEmail(normalized);
        if (!user) return;

        const token = generateOpaqueToken('ic_pr');
        const tokenHash = await hashOpaqueToken(token);
        const expiresAt = addSeconds(this.now(), 60 * 30).toISOString();
        await this.deps.authRepo.insertAuthToken({
            userId: user.id,
            tokenHash,
            kind: 'password_reset',
            expiresAt,
        });
        const resetUrl = `${this.deps.config.publicBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
        await this.deps.mailer.sendPasswordResetEmail({ to: normalized, resetUrl });
    }

    async resetPassword(token: string, newPassword: string): Promise<void> {
        if (newPassword.length < 8) throw new AuthError('weak_password', 'Password must be at least 8 characters');
        const hash = await hashOpaqueToken(token);
        const row = await this.deps.authRepo.consumeAuthToken('password_reset', hash, this.now().toISOString());
        if (!row) throw new AuthError('invalid_token', 'Reset link is invalid or expired');
        const passwordHash = await hashAuthPassword(newPassword);
        await this.deps.authRepo.updateUserPassword(row.user_id, passwordHash);
    }

    async startGoogleDeviceFlow(): Promise<{
        deviceCode: string;
        userCode: string;
        verificationUrl: string;
        expiresIn: number;
        interval: number;
    }> {
        const google = this.requireGoogle();
        const started = await google.startDeviceFlow();
        const deviceCodeHash = await hashOpaqueToken(started.device_code);
        await this.deps.authRepo.insertOAuthDeviceFlow({
            provider: 'google',
            deviceCodeHash,
            providerDeviceCode: started.device_code,
            userCode: started.user_code,
            verificationUrl: started.verification_url,
            expiresAt: addSeconds(this.now(), started.expires_in).toISOString(),
        });
        return {
            deviceCode: started.device_code,
            userCode: started.user_code,
            verificationUrl: started.verification_url,
            expiresIn: started.expires_in,
            interval: started.interval,
        };
    }

    async pollGoogleDeviceFlow(deviceCode: string, deviceId?: string, deviceName?: string): Promise<
        | { status: 'pending' }
        | { status: 'complete'; user: UserRow; tokens: AuthTokenPair }
    > {
        const google = this.requireGoogle();
        const deviceCodeHash = await hashOpaqueToken(deviceCode);
        const row = await this.deps.authRepo.findOAuthDeviceFlowByHash(deviceCodeHash);
        if (!row) throw new AuthError('invalid_device_code', 'Unknown device authorization request');
        if (row.completed_at && row.user_id && row.session_bundle) {
            const user = await this.deps.authRepo.findUserById(row.user_id);
            if (!user) throw new AuthError('invalid_device_code', 'Session incomplete');
            return {
                status: 'complete',
                user,
                tokens: row.session_bundle as unknown as AuthTokenPair,
            };
        }

        const poll = await google.pollDeviceToken(row.provider_device_code);
        if (poll.status === 'pending') return { status: 'pending' };

        const profile = await google.fetchUserInfo(poll.tokens.access_token);
        const result = await this.loginOrRegisterGoogle(profile, deviceId, deviceName);
        await this.deps.authRepo.completeOAuthDeviceFlow(row.id, {
            userId: result.user.id,
            sessionBundle: result.tokens as unknown as Record<string, unknown>,
        });
        return { status: 'complete', ...result };
    }

    buildGoogleAuthorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string {
        return this.requireGoogle().buildAuthorizeUrl(input);
    }

    async completeGoogleAuthorizationCode(input: {
        code: string;
        redirectUri: string;
        codeVerifier: string;
        deviceId?: string;
        deviceName?: string;
    }): Promise<{ user: UserRow; tokens: AuthTokenPair }> {
        const google = this.requireGoogle();
        const tokens = await google.exchangeAuthorizationCode(input);
        const profile = await google.fetchUserInfo(tokens.access_token);
        return this.loginOrRegisterGoogle(profile, input.deviceId, input.deviceName);
    }

    async getUserById(id: number): Promise<UserRow | null> {
        return this.deps.authRepo.findUserById(id);
    }

    private requireGoogle(): GoogleOAuthClient {
        if (!this.deps.google) {
            throw new AuthError('google_not_configured', 'Google sign-in is not configured on this server');
        }
        return this.deps.google;
    }

    private async loginOrRegisterGoogle(
        profile: GoogleUserInfo,
        deviceId?: string,
        deviceName?: string,
    ): Promise<{ user: UserRow; tokens: AuthTokenPair }> {
        const sub = String(profile.sub ?? '').trim();
        if (!sub) throw new AuthError('google_profile', 'Google profile missing subject');

        let user: UserRow | null = null;
        const identity = await this.deps.authRepo.findIdentity('google', sub);
        if (identity) {
            user = await this.deps.authRepo.findUserById(identity.user_id);
        }

        const email = profile.email ? normalizeEmail(profile.email) : null;
        if (!user && email) {
            user = await this.deps.authRepo.findUserByEmail(email);
        }

        if (!user) {
            user = await this.deps.authRepo.createUser({
                publicId: generateUserPublicId(),
                email: email ?? `${sub}@users.google.infinitecontext.local`,
                passwordHash: null,
                emailVerifiedAt: profile.email_verified ? this.now().toISOString() : null,
            });
        } else if (profile.email_verified && !user.email_verified_at) {
            await this.deps.authRepo.markEmailVerified(user.id, this.now().toISOString());
            user = (await this.deps.authRepo.findUserById(user.id)) ?? user;
        }

        if (!identity) {
            await this.deps.authRepo.createIdentity({
                userId: user.id,
                provider: 'google',
                providerUserId: sub,
                email,
            });
        }

        await this.ensureUserProject(user.id);
        const tokens = await this.issueSession(user, deviceId, deviceName);
        return { user, tokens };
    }

    private async ensureUserProject(userId: number): Promise<number> {
        const existing = await this.deps.authRepo.findProjectIdByUserId(userId);
        if (existing) return existing;

        const project = await this.deps.storage.insertProject(`user-${userId}`);
        if (!project) throw new Error('Failed to create user project');
        await this.deps.authRepo.linkUserProject(userId, project.id);
        return project.id;
    }

    private async issueSession(user: UserRow, deviceId?: string, deviceName?: string): Promise<AuthTokenPair> {
        const projectId = await this.ensureUserProject(user.id);
        const refreshToken = generateRefreshToken();
        const refreshHash = await hashRefreshToken(refreshToken);
        const refreshExpiresAt = addSeconds(this.now(), this.deps.config.refreshTokenTtlSec).toISOString();

        const session = await this.deps.authRepo.createSession({
            publicId: generateSessionPublicId(),
            userId: user.id,
            refreshTokenHash: refreshHash,
            deviceId: deviceId ?? null,
            deviceName: deviceName ?? null,
            expiresAt: refreshExpiresAt,
        });

        const access = await signAccessToken(this.deps.config, {
            sub: user.public_id,
            uid: user.id,
            pid: projectId,
            sid: session.id,
        });

        return {
            accessToken: access.token,
            refreshToken,
            accessTokenExpiresAt: access.expiresAt,
            refreshTokenExpiresAt: refreshExpiresAt,
            tokenType: 'Bearer',
        };
    }
}

export class AuthError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
    }
}

function normalizeEmail(email: string): string | null {
    const trimmed = String(email ?? '').trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) return null;
    return trimmed;
}

function addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1000);
}
