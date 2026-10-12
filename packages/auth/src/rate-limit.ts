export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

type Bucket = {
    count: number;
    resetAtMs: number;
};

const DEFAULT_MAX_BUCKETS = 10_000;

export class MemoryRateLimiter {
    private readonly buckets = new Map<string, Bucket>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly maxBuckets = DEFAULT_MAX_BUCKETS,
    ) {}

    check(key: string, nowMs = Date.now()): RateLimitDecision {
        const normalized = key.trim().toLowerCase();
        if (!normalized) return { allowed: true };

        this.evictExpired(nowMs);

        const existing = this.buckets.get(normalized);
        if (!existing || existing.resetAtMs <= nowMs) {
            this.buckets.set(normalized, { count: 1, resetAtMs: nowMs + this.windowMs });
            this.enforceMaxBuckets();
            return { allowed: true };
        }

        if (existing.count >= this.limit) {
            const retryAfterSec = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
            return { allowed: false, retryAfterSec };
        }

        existing.count += 1;
        this.buckets.delete(normalized);
        this.buckets.set(normalized, existing);
        return { allowed: true };
    }

    private evictExpired(nowMs: number): void {
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAtMs <= nowMs) this.buckets.delete(key);
        }
    }

    private enforceMaxBuckets(): void {
        while (this.buckets.size > this.maxBuckets) {
            const oldest = this.buckets.keys().next().value;
            if (oldest === undefined) break;
            this.buckets.delete(oldest);
        }
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
