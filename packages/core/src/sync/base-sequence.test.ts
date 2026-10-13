import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isBaseSequenceAboveHead, parseStrictBaseSequence } from './base-sequence';

describe('parseStrictBaseSequence', () => {
    it('accepts safe non-negative integers', () => {
        assert.equal(parseStrictBaseSequence(0), 0);
        assert.equal(parseStrictBaseSequence('42'), 42);
        assert.equal(parseStrictBaseSequence(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    });

    it('rejects non-integers, negatives, and unsafe magnitudes', () => {
        assert.equal(parseStrictBaseSequence(-1), null);
        assert.equal(parseStrictBaseSequence('abc'), null);
        assert.equal(parseStrictBaseSequence(1.5), null);
        assert.equal(parseStrictBaseSequence(1e30), null);
        assert.equal(parseStrictBaseSequence('99999999999999999999'), null);
        assert.equal(parseStrictBaseSequence(Number.MAX_SAFE_INTEGER + 1), null);
    });
});

describe('isBaseSequenceAboveHead', () => {
    it('flags bases strictly above head', () => {
        assert.equal(isBaseSequenceAboveHead(5, 4), true);
        assert.equal(isBaseSequenceAboveHead(4, 4), false);
        assert.equal(isBaseSequenceAboveHead(0, 0), false);
    });
});
