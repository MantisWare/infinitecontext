import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encryptNodeContent, randomBytes } from './index';
import { ENCRYPTED_CONTENT_MARKER } from './node-payload';
import { extractMessageWrites, isEncryptedWritePayload, metadataHasSensitivePlaintext } from './plaintext-policy';

describe('plaintext policy', () => {
    it('detects sensitive plaintext metadata', () => {
        assert.equal(metadataHasSensitivePlaintext({ source: 'claude' }), false);
        assert.equal(metadataHasSensitivePlaintext({ source: 'claude', note: 'secret' }), true);
    });

    it('accepts encrypted write payloads', () => {
        const dek = randomBytes(32);
        const content = encryptNodeContent(dek, 1, { text: 'hello' }, {
            contextId: 'ctx_1',
            userPublicId: 'usr_1',
            dekVersion: 1,
        });
        assert.equal(
            isEncryptedWritePayload(content as Record<string, unknown>, { source: 'claude' }),
            true,
        );
    });

    it('extracts append and patch update writes', () => {
        const writes = extractMessageWrites([{ role: 'user', text: 'a', metadata: { source: 'x' } }]);
        assert.equal(writes.length, 1);
        const patchWrites = extractMessageWrites({ updates: [{ id: 'm1', text: 'b' }] });
        assert.equal(patchWrites.length, 1);
    });

    it('rejects plaintext message bodies for initialized vaults', () => {
        assert.equal(isEncryptedWritePayload({ text: 'plain' }, {}), false);
        assert.equal(isEncryptedWritePayload({ [ENCRYPTED_CONTENT_MARKER]: 1 }, {}), false);
    });
});
