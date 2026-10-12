export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

type Bucket = {
    count: number;
    resetAtMs: number;
};

export class MemoryRateLimiter {
    private readonly buckets = new Map<string, Bucket>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {}

    check(key: string, nowMs = Date.now()): RateLimitDecision {
        const normalized = key.trim().toLowerCase();
        if (!normalized) return { allowed: true };

        const existing = this.buckets.get(normalized);
        if (!existing || existing.resetAtMs <= nowMs) {
            this.buckets.set(normalized, { count: 1, resetAtMs: nowMs + this.windowMs });
            return { allowed: true };
        }

        if (existing.count >= this.limit) {
            const retryAfterSec = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
            return { allowed: false, retryAfterSec };
        }

        existing.count += 1;
        return { allowed: true };
    }
}

export type AuthRateLimiters = {
    byIp: MemoryRateLimiter;
    byAccount: MemoryRateLimiter;
};

export function createAuthRateLimiters(): AuthRateLimiters {
    return {
        byIp: new MemoryRateLimiter(30, 60_000),
        byAccount: new MemoryRateLimiter(10, 60_000),
    };
}
