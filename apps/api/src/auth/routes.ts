import {
    AuthService,
    createGoogleOAuthClient,
    generateOpaqueToken,
    hashOpaqueToken,
    type AuthRepository,
    type AuthRuntimeConfig,
    type GoogleOAuthClient,
    type Mailer,
} from '@infinitecontext/auth';
import type { StorageAdapter } from '@infinitecontext/core';

import { mapAuthError } from './errors';
import type { HttpApp } from '../types/http';

export type AuthRouteDeps = {
    authConfig: AuthRuntimeConfig;
    authRepo: AuthRepository;
    storage: StorageAdapter;
    mailer: Mailer;
    google?: GoogleOAuthClient;
};

function tokenResponse(c: { json: (body: unknown, status?: number) => Response }, tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    tokenType: 'Bearer';
}) {
    return c.json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType,
        expires_at: tokens.accessTokenExpiresAt,
        refresh_expires_at: tokens.refreshTokenExpiresAt,
    });
}

export function registerAuthRoutes(app: HttpApp, deps: AuthRouteDeps) {
    const service = new AuthService({
        authRepo: deps.authRepo,
        storage: deps.storage,
        config: deps.authConfig,
        mailer: deps.mailer,
        google: deps.google,
    });

    app.post('/auth/register', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const result = await service.registerWithPassword({
                email: String(body.email ?? ''),
                password: String(body.password ?? ''),
                deviceId: body.device_id ? String(body.device_id) : undefined,
                deviceName: body.device_name ? String(body.device_name) : undefined,
            });
            return tokenResponse(c, result.tokens);
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/login', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const result = await service.loginWithPassword({
                email: String(body.email ?? ''),
                password: String(body.password ?? ''),
                deviceId: body.device_id ? String(body.device_id) : undefined,
                deviceName: body.device_name ? String(body.device_name) : undefined,
            });
            return tokenResponse(c, result.tokens);
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/refresh', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const refreshToken = String(body.refresh_token ?? '');
            const tokens = await service.refresh(refreshToken);
            return tokenResponse(c, tokens);
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/logout', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const refreshToken = String(body.refresh_token ?? '');
        if (refreshToken) await service.logout(refreshToken);
        return c.json({ ok: true });
    });

    app.get('/auth/me', async (c) => {
        const auth = c.get('auth');
        if (auth.kind !== 'user_session') {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        const user = await service.getUserById(auth.userId);
        if (!user) return c.json({ error: 'Unauthorized' }, 401);
        return c.json({
            id: user.public_id,
            email: user.email,
            email_verified: Boolean(user.email_verified_at),
            project_id: auth.projectId,
        });
    });

    app.get('/auth/verify-email', async (c) => {
        try {
            const token = String(c.req.query('token') ?? '');
            await service.verifyEmail(token);
            return c.json({ ok: true });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/verify-email', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const token = String(body.token ?? c.req.query('token') ?? '');
            await service.verifyEmail(token);
            return c.json({ ok: true });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/request-password-reset', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        await service.requestPasswordReset(String(body.email ?? ''));
        return c.json({ ok: true });
    });

    app.post('/auth/reset-password', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            await service.resetPassword(String(body.token ?? ''), String(body.password ?? ''));
            return c.json({ ok: true });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/oauth/google/device/start', async (c) => {
        try {
            const started = await service.startGoogleDeviceFlow();
            return c.json({
                device_code: started.deviceCode,
                user_code: started.userCode,
                verification_url: started.verificationUrl,
                expires_in: started.expiresIn,
                interval: started.interval,
            });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/oauth/google/device/poll', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const result = await service.pollGoogleDeviceFlow(
                String(body.device_code ?? ''),
                body.device_id ? String(body.device_id) : undefined,
                body.device_name ? String(body.device_name) : undefined,
            );
            if (result.status === 'pending') {
                return c.json({ status: 'pending' }, 202);
            }
            return c.json({
                status: 'complete',
                user: { id: result.user.public_id, email: result.user.email },
                ...serializeTokens(result.tokens),
            });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.get('/auth/oauth/google/authorize', async (c) => {
        try {
            const redirectUri = String(c.req.query('redirect_uri') ?? '');
            if (!redirectUri) return c.json({ error: 'redirect_uri is required' }, 400);

            const codeVerifier = generatePkceVerifier();
            const codeChallenge = await pkceChallenge(codeVerifier);
            const state = generateOpaqueToken('ic_oauth_state');
            const stateHash = await hashOpaqueToken(state);
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

            await deps.authRepo.insertOAuthState({
                state_hash: stateHash,
                provider: 'google',
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
                expires_at: expiresAt,
                created_at: new Date().toISOString(),
            });

            const url = service.buildGoogleAuthorizeUrl({ redirectUri, state, codeChallenge });
            return c.redirect(url, 302);
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post('/auth/oauth/google/callback', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const code = String(body.code ?? '');
            const state = String(body.state ?? '');
            const redirectUri = String(body.redirect_uri ?? '');
            if (!code || !state || !redirectUri) {
                return c.json({ error: 'code, state, and redirect_uri are required' }, 400);
            }

            const stateHash = await hashOpaqueToken(state);
            const oauthState = await deps.authRepo.consumeOAuthState(stateHash, new Date().toISOString());
            if (!oauthState || oauthState.redirect_uri !== redirectUri) {
                return c.json({ error: 'Invalid OAuth state' }, 401);
            }

            const result = await service.completeGoogleAuthorizationCode({
                code,
                redirectUri,
                codeVerifier: oauthState.code_verifier,
                deviceId: body.device_id ? String(body.device_id) : undefined,
                deviceName: body.device_name ? String(body.device_name) : undefined,
            });

            return c.json({
                user: { id: result.user.public_id, email: result.user.email },
                ...serializeTokens(result.tokens),
            });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });
}

function serializeTokens(tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    tokenType: 'Bearer';
}) {
    return {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType,
        expires_at: tokens.accessTokenExpiresAt,
        refresh_expires_at: tokens.refreshTokenExpiresAt,
    };
}

function generatePkceVerifier(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString('base64url');
}

async function pkceChallenge(verifier: string): Promise<string> {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Buffer.from(new Uint8Array(digest)).toString('base64url');
}

export function resolveGoogleClient(config: AuthRuntimeConfig, fetchFn?: typeof fetch): GoogleOAuthClient | undefined {
    if (!config.googleClientId || !config.googleClientSecret) return undefined;
    return createGoogleOAuthClient(config.googleClientId, config.googleClientSecret, fetchFn);
}
