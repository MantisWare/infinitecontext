import { createAuthRateLimiters, type AuthRateLimiters } from '@infinitecontext/auth';

import type { HttpContext } from '../types/http';

export type AuthRateLimitBundle = AuthRateLimiters;

export function createAuthRouteRateLimiters(): AuthRateLimitBundle {
    return createAuthRateLimiters();
}

export function readClientIp(c: HttpContext): string {
    const forwarded = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
    return c.req.header('x-real-ip') ?? 'unknown';
}

export function enforceRateLimit(
    c: HttpContext,
    limiters: AuthRateLimitBundle,
    accountKey?: string,
): Response | null {
    const ipDecision = limiters.byIp.check(readClientIp(c));
    if (!ipDecision.allowed) {
        c.header('Retry-After', String(ipDecision.retryAfterSec));
        return c.json({ error: 'Too many requests' }, 429);
    }

    if (accountKey) {
        const accountDecision = limiters.byAccount.check(accountKey);
        if (!accountDecision.allowed) {
            c.header('Retry-After', String(accountDecision.retryAfterSec));
            return c.json({ error: 'Too many requests' }, 429);
        }
    }

    return null;
}
