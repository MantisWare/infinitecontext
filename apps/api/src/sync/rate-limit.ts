import { MemoryRateLimiter } from '@infinitecontext/auth';

export type SyncRateLimiters = {
    pullByUser: MemoryRateLimiter;
    pushByUser: MemoryRateLimiter;
};

export function createSyncRateLimiters(): SyncRateLimiters {
    return {
        pullByUser: new MemoryRateLimiter(120, 60_000),
        pushByUser: new MemoryRateLimiter(60, 60_000),
    };
}

export function enforceSyncRateLimit(
    limiter: MemoryRateLimiter,
    userId: number,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
    return limiter.check(`user:${userId}`);
}
