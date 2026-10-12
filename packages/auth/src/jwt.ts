import { SignJWT, jwtVerify } from 'jose';

import type { AccessTokenClaims, AuthRuntimeConfig } from './types';

function secretKey(secret: string) {
    return new TextEncoder().encode(secret);
}

export async function signAccessToken(
    config: AuthRuntimeConfig,
    claims: Omit<AccessTokenClaims, 'typ'>,
): Promise<{ token: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + config.accessTokenTtlSec * 1000);
    const token = await new SignJWT({ ...claims, typ: 'access' satisfies AccessTokenClaims['typ'] })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuedAt()
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(secretKey(config.jwtSecret));

    return { token, expiresAt: expiresAt.toISOString() };
}

export async function verifyAccessToken(config: AuthRuntimeConfig, token: string): Promise<AccessTokenClaims | null> {
    try {
        const { payload } = await jwtVerify(token, secretKey(config.jwtSecret), {
            algorithms: ['HS256'],
        });
        if (payload.typ !== 'access') return null;
        const uid = Number(payload.uid);
        const pid = Number(payload.pid);
        const sid = Number(payload.sid);
        const sub = String(payload.sub ?? '');
        if (!Number.isFinite(uid) || !Number.isFinite(pid) || !Number.isFinite(sid) || !sub) return null;
        return { sub, uid, pid, sid, typ: 'access' };
    } catch {
        return null;
    }
}

export function looksLikeApiKey(token: string): boolean {
    return token.startsWith('ic_live_') || token.startsWith('ic_test_');
}

export function looksLikeJwt(token: string): boolean {
    return token.split('.').length === 3 && token.startsWith('eyJ');
}
