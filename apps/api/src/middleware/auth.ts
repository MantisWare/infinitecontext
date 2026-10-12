import { hashToken, verifyKeyHash } from '@infinitecontext/core';
import { looksLikeApiKey, verifyAccessToken, type AuthRepository, type AuthRuntimeConfig } from '@infinitecontext/auth';

import type { KeyCache } from '../cache/types';
import type { HttpApp, HttpContext, HttpMiddleware } from '../types/http';

// -- helpers ------------------------------------------------------------------

function readBearerToken(c: HttpContext): string | null {
    const authorization = c.req.header('authorization');
    if (!authorization) return null;

    const [scheme, token] = authorization.split(' ');
    if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
    return token;
}

function unauthorized(c: HttpContext) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Unauthorized' }, 401);
}

async function recordApiKeyUse(c: HttpContext, apiKeyId: number) {
    try {
        await c.get('storage').updateApiKeyLastUsedAt(apiKeyId, new Date().toISOString());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to update api_keys.last_used_at for key ${apiKeyId}: ${message}`);
    }
}

function bearerAuthMiddleware(verify: (token: string, c: HttpContext) => Promise<boolean>): HttpMiddleware {
    return async (c, next) => {
        const token = readBearerToken(c as HttpContext);
        if (!token) return unauthorized(c as HttpContext);

        const ok = await verify(token, c as HttpContext);
        if (!ok) return unauthorized(c as HttpContext);

        await next();
    };
}

async function verifyActiveSession(authRepo: AuthRepository, sessionId: number): Promise<boolean> {
    const session = await authRepo.findSessionById(sessionId);
    if (!session) return false;
    if (session.revoked_at) return false;
    if (Date.parse(session.expires_at) <= Date.now()) return false;
    return true;
}

async function verifyUserAccessToken(
    authConfig: AuthRuntimeConfig,
    authRepo: AuthRepository,
    token: string,
    c: HttpContext,
): Promise<boolean> {
    const claims = await verifyAccessToken(authConfig, token);
    if (!claims) return false;
    const active = await verifyActiveSession(authRepo, claims.sid);
    if (!active) return false;
    c.set('auth', {
        kind: 'user_session',
        userId: claims.uid,
        projectId: claims.pid,
        sessionId: claims.sid,
    });
    return true;
}

// -- token verification -------------------------------------------------------

function createTokenVerifier(keyCache?: KeyCache) {
    return async function verifyToken(token: string, c: HttpContext) {
        const { prefix, hash } = await hashToken(token);

        if (keyCache) {
            const cached = await keyCache.get(prefix);
            if (cached && cached.keyHash === hash) {
                c.set('auth', { kind: 'api_key', apiKeyId: cached.apiKeyId, projectId: cached.projectId });
                await recordApiKeyUse(c, cached.apiKeyId);
                return true;
            }
        }

        const storage = c.get('storage');
        const verified = await verifyKeyHash(storage, prefix, hash);
        if (!verified) return false;

        c.set('auth', { kind: 'api_key', apiKeyId: verified.apiKeyId, projectId: verified.projectId });

        if (keyCache) {
            await keyCache.put(prefix, {
                keyHash: hash,
                apiKeyId: verified.apiKeyId,
                projectId: verified.projectId,
            });
        }

        await recordApiKeyUse(c, verified.apiKeyId);

        return true;
    };
}

function createCombinedContextVerifier(
    authConfig: AuthRuntimeConfig | null,
    authRepo: AuthRepository | null,
    keyCache?: KeyCache,
) {
    const verifyApiKey = createTokenVerifier(keyCache);
    return async function verifyContextToken(token: string, c: HttpContext) {
        if (looksLikeApiKey(token)) {
            return verifyApiKey(token, c);
        }
        if (!authConfig || !authRepo) return false;
        return verifyUserAccessToken(authConfig, authRepo, token, c);
    };
}

async function verifyAdminToken(token: string, c: HttpContext) {
    const expected = c.get('config').INFINITECONTEXT_ADMIN_KEY;
    if (!expected) return false;
    return token === expected;
}

// -- registration -------------------------------------------------------------

export type AuthOptions = {
    keyCache?: KeyCache;
    authConfig?: AuthRuntimeConfig | null;
    authRepo?: AuthRepository | null;
};

export function registerAuthMiddleware(app: HttpApp, options?: AuthOptions) {
    const verifyContextToken = createCombinedContextVerifier(
        options?.authConfig ?? null,
        options?.authRepo ?? null,
        options?.keyCache,
    );

    app.use('/contexts', bearerAuthMiddleware(verifyContextToken));
    app.use('/contexts/*', bearerAuthMiddleware(verifyContextToken));
    app.use('/mcp', bearerAuthMiddleware(verifyContextToken));
    app.use('/v1/keys', bearerAuthMiddleware(verifyAdminToken));

    if (options?.authConfig && options.authRepo) {
        const verifyUser = async (token: string, c: HttpContext) =>
            verifyUserAccessToken(options.authConfig!, options.authRepo!, token, c);

        app.use('/auth/me', bearerAuthMiddleware(verifyUser));
        app.use('/auth/crypto', bearerAuthMiddleware(verifyUser));
        app.use('/auth/crypto/*', bearerAuthMiddleware(verifyUser));
        app.use('/auth/devices', bearerAuthMiddleware(verifyUser));
        app.use('/auth/devices/*', bearerAuthMiddleware(verifyUser));
        app.use('/sync', bearerAuthMiddleware(verifyUser));
        app.use('/sync/*', bearerAuthMiddleware(verifyUser));
    }
}
