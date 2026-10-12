import type { AuthRuntimeConfig } from './types';

function readInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = String(env[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function buildAuthRuntimeConfig(env: Record<string, string | undefined>): AuthRuntimeConfig | null {
    const jwtSecret = String(env.INFINITECONTEXT_JWT_SECRET ?? '').trim();
    if (!jwtSecret) return null;

    const googleClientId = String(env.INFINITECONTEXT_GOOGLE_CLIENT_ID ?? '').trim();
    const googleClientSecret = String(env.INFINITECONTEXT_GOOGLE_CLIENT_SECRET ?? '').trim();

    return {
        jwtSecret,
        accessTokenTtlSec: readInt(env, 'INFINITECONTEXT_ACCESS_TOKEN_TTL_SEC', 900),
        refreshTokenTtlSec: readInt(env, 'INFINITECONTEXT_REFRESH_TOKEN_TTL_SEC', 60 * 60 * 24 * 7),
        publicBaseUrl: String(env.INFINITECONTEXT_AUTH_PUBLIC_BASE_URL ?? env.INFINITECONTEXT_PUBLIC_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
        googleClientId: googleClientId || undefined,
        googleClientSecret: googleClientSecret || undefined,
    };
}
