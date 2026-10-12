import {
    AuthService,
    createGoogleOAuthClient,
    isAllowedOAuthRedirectUri,
    type AuthRepository,
    type AuthRateLimiters,
    type AuthRuntimeConfig,
    type GoogleOAuthClient,
    type Mailer,
} from '@infinitecontext/auth';
import type { StorageAdapter } from '@infinitecontext/core';

import { mapAuthError } from './errors';
import { enforceRateLimit, readClientIp } from './rate-limit';
import type { HttpApp, HttpContext } from '../types/http';

export type AuthRouteDeps = {
    authConfig: AuthRuntimeConfig;
    authRepo: AuthRepository;
    storage: StorageAdapter;
    mailer: Mailer;
    google?: GoogleOAuthClient;
    rateLimiters: AuthRateLimiters;
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

function accountKeyFromEmail(email: unknown): string | undefined {
    const normalized = String(email ?? '').trim().toLowerCase();
    return normalized || undefined;
}

export function registerAuthRoutes(app: HttpApp, deps: AuthRouteDeps) {
    const service = new AuthService({
        authRepo: deps.authRepo,
        storage: deps.storage,
        config: deps.authConfig,
        mailer: deps.mailer,
        google: deps.google,
    });

    const withRateLimit = (
        handler: (c: HttpContext, body: Record<string, unknown>) => Promise<Response>,
        accountField?: string,
    ) => {
        return async (c: HttpContext) => {
            const body = await c.req.json().catch(() => ({}));
            const accountKey = accountField ? accountKeyFromEmail(body[accountField]) : undefined;
            const limited = enforceRateLimit(c, deps.rateLimiters, accountKey ?? `${readClientIp(c)}:anonymous`);
            if (limited) return limited;
            return handler(c, body as Record<string, unknown>);
        };
    };

    app.post(
        '/auth/register',
        withRateLimit(async (c, body) => {
            try {
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
        }, 'email'),
    );

    app.post(
        '/auth/login',
        withRateLimit(async (c, body) => {
            try {
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
        }, 'email'),
    );

    app.post(
        '/auth/refresh',
        withRateLimit(async (c, body) => {
            try {
                const refreshToken = String(body.refresh_token ?? '');
                const tokens = await service.refresh(refreshToken);
                return tokenResponse(c, tokens);
            } catch (error) {
                const mapped = mapAuthError(error);
                return c.json({ error: mapped.message }, mapped.status);
            }
        }),
    );

    app.post(
        '/auth/logout',
        withRateLimit(async (c, body) => {
            const refreshToken = String(body.refresh_token ?? '');
            if (refreshToken) await service.logout(refreshToken);
            return c.json({ ok: true });
        }),
    );

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
        const limited = enforceRateLimit(c, deps.rateLimiters, `${readClientIp(c)}:verify`);
        if (limited) return limited;
        try {
            const token = String(c.req.query('token') ?? '');
            await service.verifyEmail(token);
            return c.json({ ok: true });
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post(
        '/auth/verify-email',
        withRateLimit(async (c, body) => {
            try {
                const token = String(body.token ?? c.req.query('token') ?? '');
                await service.verifyEmail(token);
                return c.json({ ok: true });
            } catch (error) {
                const mapped = mapAuthError(error);
                return c.json({ error: mapped.message }, mapped.status);
            }
        }),
    );

    app.post(
        '/auth/request-password-reset',
        withRateLimit(async (c, body) => {
            await service.requestPasswordReset(String(body.email ?? ''));
            return c.json({ ok: true });
        }, 'email'),
    );

    app.post(
        '/auth/reset-password',
        withRateLimit(async (c, body) => {
            try {
                await service.resetPassword(String(body.token ?? ''), String(body.password ?? ''));
                return c.json({ ok: true });
            } catch (error) {
                const mapped = mapAuthError(error);
                return c.json({ error: mapped.message }, mapped.status);
            }
        }),
    );

    app.post(
        '/auth/oauth/google/device/start',
        withRateLimit(async (c) => {
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
        }),
    );

    app.post(
        '/auth/oauth/google/device/poll',
        withRateLimit(async (c, body) => {
            try {
                const result = await service.pollGoogleDeviceFlow(
                    String(body.device_code ?? ''),
                    body.device_id ? String(body.device_id) : undefined,
                    body.device_name ? String(body.device_name) : undefined,
                );
                if (result.status === 'pending') {
                    return c.json({ status: 'pending' }, 202);
                }
                if (result.status === 'expired') {
                    return c.json({ status: 'expired', error: 'Device authorization expired' }, 410);
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
        }),
    );

    app.get('/auth/oauth/google/authorize', async (c) => {
        const limited = enforceRateLimit(c, deps.rateLimiters, `${readClientIp(c)}:oauth`);
        if (limited) return limited;
        try {
            const redirectUri = String(c.req.query('redirect_uri') ?? '');
            const state = String(c.req.query('state') ?? '');
            const codeChallenge = String(c.req.query('code_challenge') ?? '');
            if (!redirectUri || !state || !codeChallenge) {
                return c.json({ error: 'redirect_uri, state, and code_challenge are required' }, 400);
            }
            if (!isAllowedOAuthRedirectUri(redirectUri)) {
                return c.json({ error: 'redirect_uri is not allowed' }, 400);
            }

            const url = service.buildGoogleAuthorizeUrl({ redirectUri, state, codeChallenge });
            return c.redirect(url, 302);
        } catch (error) {
            const mapped = mapAuthError(error);
            return c.json({ error: mapped.message }, mapped.status);
        }
    });

    app.post(
        '/auth/oauth/google/callback',
        withRateLimit(async (c, body) => {
            try {
                const code = String(body.code ?? '');
                const redirectUri = String(body.redirect_uri ?? '');
                const codeVerifier = String(body.code_verifier ?? '');
                if (!code || !redirectUri || !codeVerifier) {
                    return c.json({ error: 'code, redirect_uri, and code_verifier are required' }, 400);
                }
                if (!isAllowedOAuthRedirectUri(redirectUri)) {
                    return c.json({ error: 'redirect_uri is not allowed' }, 400);
                }

                const result = await service.completeGoogleAuthorizationCode({
                    code,
                    redirectUri,
                    codeVerifier,
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
        }),
    );
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

export function resolveGoogleClient(config: AuthRuntimeConfig, fetchFn?: typeof fetch): GoogleOAuthClient | undefined {
    if (!config.googleClientId || !config.googleClientSecret) return undefined;
    return createGoogleOAuthClient(config.googleClientId, config.googleClientSecret, fetchFn);
}
