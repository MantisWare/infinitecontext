import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseBaseSequence } from '../sync/parse-base-sequence';

function mockContext(headers: Record<string, string>) {
    return {
        req: {
            header(name: string) {
                const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
                return key ? headers[key] : undefined;
            },
        },
    };
}

describe('parseBaseSequence', () => {
    it('reads valid X-IC-Base-Sequence, If-Match, and body.base_sequence', () => {
        assert.deepEqual(parseBaseSequence(mockContext({ 'X-IC-Base-Sequence': '42' }) as any, {}), {
            status: 'ok',
            value: 42,
        });
        assert.deepEqual(parseBaseSequence(mockContext({ 'If-Match': 'seq=7' }) as any, {}), {
            status: 'ok',
            value: 7,
        });
        assert.deepEqual(parseBaseSequence(mockContext({}) as any, { base_sequence: 3 }), {
            status: 'ok',
            value: 3,
        });
        assert.deepEqual(parseBaseSequence(mockContext({}) as any, {}), { status: 'missing' });
    });

    it('rejects invalid base values with status invalid', () => {
        assert.deepEqual(parseBaseSequence(mockContext({ 'X-IC-Base-Sequence': 'abc' }) as any, {}), {
            status: 'invalid',
        });
        assert.deepEqual(parseBaseSequence(mockContext({ 'X-IC-Base-Sequence': '-1' }) as any, {}), {
            status: 'invalid',
        });
        assert.deepEqual(parseBaseSequence(mockContext({}) as any, { base_sequence: 'nope' }), {
            status: 'invalid',
        });
        assert.deepEqual(parseBaseSequence(mockContext({}) as any, { base_sequence: -1 }), {
            status: 'invalid',
        });
        assert.deepEqual(parseBaseSequence(mockContext({ 'X-IC-Base-Sequence': '1e30' }) as any, {}), {
            status: 'invalid',
        });
        assert.deepEqual(
            parseBaseSequence(mockContext({}) as any, { base_sequence: '99999999999999999999' }),
            { status: 'invalid' },
        );
        assert.deepEqual(parseBaseSequence(mockContext({}) as any, { base_sequence: 1e30 }), {
            status: 'invalid',
        });
    });
});
