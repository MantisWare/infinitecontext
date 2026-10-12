import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encryptNodeContent, randomBytes } from './index';
import { ENCRYPTED_CONTENT_MARKER } from './node-payload';
import {
    deleteBodyMetadata,
    extractMessageWrites,
    isEncryptedWritePayload,
    metadataHasSensitivePlaintext,
} from './plaintext-policy';

describe('plaintext policy', () => {
    const binding = {
        contextId: 'ctx_1',
        userPublicId: 'usr_1',
        nodeIndex: 0,
    };

    it('detects sensitive plaintext metadata', () => {
        assert.equal(metadataHasSensitivePlaintext({ source: 'claude' }), false);
        assert.equal(metadataHasSensitivePlaintext({ source: 'claude', note: 'secret' }), true);
    });

    it('accepts strict encrypted write payloads', () => {
        const dek = randomBytes(32);
        const content = encryptNodeContent(dek, 1, { text: 'hello' }, binding);
        assert.equal(isEncryptedWritePayload(content as Record<string, unknown>, { source: 'claude' }), true);
    });

    it('rejects invalid nonce length', () => {
        const dek = randomBytes(32);
        const content = encryptNodeContent(dek, 1, { text: 'hello' }, binding);
        (content as Record<string, unknown>).nonce = Buffer.from('short').toString('base64');
        assert.equal(isEncryptedWritePayload(content as Record<string, unknown>, {}), false);
    });

    it('rejects envelopes with extra plaintext fields', () => {
        const dek = randomBytes(32);
        const content = encryptNodeContent(dek, 1, { text: 'hello' }, binding);
        (content as Record<string, unknown>).text = 'leak';
        assert.equal(isEncryptedWritePayload(content as Record<string, unknown>, {}), false);
    });

    it('extracts append, patch updates, and top-level metadata writes', () => {
        const writes = extractMessageWrites([{ role: 'user', text: 'a', metadata: { source: 'x' } }]);
        assert.equal(writes.length, 1);
        const patchWrites = extractMessageWrites({ updates: [{ id: 'm1', text: 'b' }] });
        assert.equal(patchWrites.length, 1);
        const metaWrite = extractMessageWrites({ updates: [], metadata: { note: 'secret' } });
        assert.equal(metaWrite.length, 1);
        assert.equal(metaWrite[0]?.metadata.note, 'secret');
    });

    it('deleteBodyMetadata reads delete metadata', () => {
        assert.deepEqual(deleteBodyMetadata({ ids: ['a'], metadata: { note: 'x' } }), { note: 'x' });
    });

    it('allows patch updates with index selector beside envelope fields', () => {
        const dek = randomBytes(32);
        const content = encryptNodeContent(dek, 1, { text: 'hello' }, binding);
        assert.equal(
            isEncryptedWritePayload({ index: 2, ...(content as Record<string, unknown>) }, {}),
            true,
        );
    });

    it('rejects plaintext message bodies for initialized vaults', () => {
        assert.equal(isEncryptedWritePayload({ text: 'plain' }, {}), false);
        assert.equal(isEncryptedWritePayload({ [ENCRYPTED_CONTENT_MARKER]: 1, kid: 'dek_v1' }, {}), false);
    });
});
