import { getConnInfo as getConnInfoDefault } from '@hono/node-server/conninfo';
import { createAuthRateLimiters, type AuthRateLimiters } from '@infinitecontext/auth';

import type { HttpContext } from '../types/http';

export type AuthRateLimitBundle = AuthRateLimiters;

export type ClientIpReaderOptions = {
    /** Cloudflare Workers: trust CF-Connecting-IP. Node: only trust forwarded headers when true. */
    trustProxy: boolean;
    runtime: 'node' | 'worker';
};

type ConnInfoReader = (c: HttpContext) => { remote?: { address?: string } };

let connInfoReader: ConnInfoReader = getConnInfoDefault as ConnInfoReader;

/** @internal Test hook for simulating distinct Node remote addresses. */
export function setConnInfoReaderForTests(reader: ConnInfoReader): void {
    connInfoReader = reader;
}

export function resetConnInfoReaderForTests(): void {
    connInfoReader = getConnInfoDefault as ConnInfoReader;
}

export function createAuthRouteRateLimiters(): AuthRateLimitBundle {
    return createAuthRateLimiters();
}

export function readClientIp(c: HttpContext, options: ClientIpReaderOptions): string {
    if (options.runtime === 'worker') {
        const cf = c.req.header('cf-connecting-ip')?.trim();
        if (cf) return cf;
    }

    if (options.trustProxy) {
        const forwarded = c.req.header('x-forwarded-for');
        if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
        const realIp = c.req.header('x-real-ip')?.trim();
        if (realIp) return realIp;
    }

    if (options.runtime === 'node') {
        try {
            const remote = connInfoReader(c)?.remote?.address?.trim();
            if (remote) return remote;
        } catch {
            // fall through when conn info is unavailable (e.g. unit tests without a socket)
        }
    }

    return '127.0.0.1';
}

export function enforceRateLimit(
    c: HttpContext,
    limiters: AuthRateLimitBundle,
    options: ClientIpReaderOptions,
    accountKey?: string,
): Response | null {
    const ipDecision = limiters.byIp.check(readClientIp(c, options));
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
