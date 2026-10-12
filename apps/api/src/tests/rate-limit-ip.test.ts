import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRateLimiter } from '@infinitecontext/auth';

import {
    enforceRateLimit,
    readClientIp,
    resetConnInfoReaderForTests,
    setConnInfoReaderForTests,
    type ClientIpReaderOptions,
} from '../auth/rate-limit';
import type { HttpContext } from '../types/http';

const nodeOptions: ClientIpReaderOptions = { runtime: 'node', trustProxy: false };

type TestContext = { testRemoteAddress: string } & HttpContext;

function mockContext(remoteAddress: string): HttpContext {
    const ctx = {
        testRemoteAddress: remoteAddress,
        req: {
            header: () => undefined,
        },
        header: () => {},
        json: (body: unknown, status?: number) =>
            new Response(JSON.stringify(body), { status: status ?? 200 }),
    };
    return ctx as unknown as HttpContext;
}

describe('readClientIp (Node)', () => {
    afterEach(() => {
        resetConnInfoReaderForTests();
    });

    it('uses distinct remote addresses when TRUSTED_PROXY is off', () => {
        setConnInfoReaderForTests((c) => ({
            remote: { address: (c as unknown as TestContext).testRemoteAddress },
        }));

        assert.equal(readClientIp(mockContext('203.0.113.10'), nodeOptions), '203.0.113.10');
        assert.equal(readClientIp(mockContext('203.0.113.11'), nodeOptions), '203.0.113.11');
    });

    it('rate limits per remote address independently', () => {
        setConnInfoReaderForTests((c) => ({
            remote: { address: (c as unknown as TestContext).testRemoteAddress },
        }));

        const limiters = {
            byIp: new MemoryRateLimiter(2, 60_000),
            byAccount: new MemoryRateLimiter(10, 60_000),
        };

        assert.equal(enforceRateLimit(mockContext('10.0.0.1'), limiters, nodeOptions), null);
        assert.equal(enforceRateLimit(mockContext('10.0.0.1'), limiters, nodeOptions), null);
        const blockedOnA = enforceRateLimit(mockContext('10.0.0.1'), limiters, nodeOptions);
        assert.ok(blockedOnA instanceof Response);
        assert.equal(blockedOnA.status, 429);

        assert.equal(enforceRateLimit(mockContext('10.0.0.2'), limiters, nodeOptions), null);
        assert.equal(enforceRateLimit(mockContext('10.0.0.2'), limiters, nodeOptions), null);
        const blockedOnB = enforceRateLimit(mockContext('10.0.0.2'), limiters, nodeOptions);
        assert.ok(blockedOnB instanceof Response);
        assert.equal(blockedOnB.status, 429);
    });
});
