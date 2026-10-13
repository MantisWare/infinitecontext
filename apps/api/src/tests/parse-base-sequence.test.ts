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
    it('reads X-IC-Base-Sequence, If-Match, and body.base_sequence', () => {
        assert.equal(parseBaseSequence(mockContext({ 'X-IC-Base-Sequence': '42' }) as any, {}), 42);
        assert.equal(parseBaseSequence(mockContext({ 'If-Match': 'seq=7' }) as any, {}), 7);
        assert.equal(parseBaseSequence(mockContext({}) as any, { base_sequence: 3 }), 3);
        assert.equal(parseBaseSequence(mockContext({}) as any, {}), null);
    });
});
