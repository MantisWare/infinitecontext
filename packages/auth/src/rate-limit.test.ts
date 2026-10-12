import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRateLimiter } from './rate-limit';

describe('MemoryRateLimiter', () => {
    it('blocks after the configured limit', () => {
        const limiter = new MemoryRateLimiter(3, 60_000);
        assert.equal(limiter.check('127.0.0.1').allowed, true);
        assert.equal(limiter.check('127.0.0.1').allowed, true);
        assert.equal(limiter.check('127.0.0.1').allowed, true);
        const blocked = limiter.check('127.0.0.1');
        assert.equal(blocked.allowed, false);
        if (!blocked.allowed) {
            assert.ok(blocked.retryAfterSec >= 1);
        }
    });
});
