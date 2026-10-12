import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createVaultCryptoMaterial,
    decryptAead,
    decryptNodeContent,
    decryptNodeMetadata,
    decodeRecoveryKey,
    deriveVaultKek,
    encodeRecoveryKey,
    encryptAead,
    encryptNodeContent,
    encryptNodeMetadata,
    randomBytes,
    recoveryKeyToKek,
    rewrapDekWithNewPassphrase,
    unwrapDek,
    wrapDek,
} from './index';

/** Fixed test vector salt (16 bytes). */
const TEST_SALT = Uint8Array.from([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
]);

describe('vault KDF + DEK wrap', () => {
    it('derives stable KEK from passphrase + salt (smoke)', async () => {
        const a = await deriveVaultKek('test-passphrase', TEST_SALT);
        const b = await deriveVaultKek('test-passphrase', TEST_SALT);
        assert.equal(a.length, 32);
        assert.deepEqual(a, b);
    });

    it('round-trips DEK wrap with passphrase KEK', async () => {
        const dek = randomBytes(32);
        const kek = await deriveVaultKek('vault-secret', TEST_SALT);
        const wrapped = wrapDek(dek, kek);
        const unwrapped = unwrapDek(wrapped, kek);
        assert.deepEqual(unwrapped, dek);
    });

    it('fails unwrap with wrong KEK', async () => {
        const material = await createVaultCryptoMaterial('correct horse');
        const wrongKek = await deriveVaultKek('wrong', material.kdfSalt);
        assert.throws(() => unwrapDek(material.wrappedDekPassphrase, wrongKek));
    });

    it('password change re-wraps DEK without changing DEK bytes', async () => {
        const material = await createVaultCryptoMaterial('old-pass');
        const rewrapped = await rewrapDekWithNewPassphrase({
            dek: material.dek,
            newPassphrase: 'new-pass',
            kdfSalt: material.kdfSalt,
        });
        const newKek = await deriveVaultKek('new-pass', material.kdfSalt);
        const dek2 = unwrapDek(rewrapped, newKek);
        assert.deepEqual(dek2, material.dek);
    });
});

describe('recovery key codec', () => {
    it('round-trips 256-bit recovery key encoding', () => {
        const raw = randomBytes(32);
        const display = encodeRecoveryKey(raw);
        const decoded = decodeRecoveryKey(display);
        assert.deepEqual(decoded, raw);
    });
});

describe('node payload AEAD', () => {
    const aadBase = {
        contextId: 'ctx_abc',
        userPublicId: 'usr_xyz',
        dekVersion: 1,
    };

    it('encrypts and decrypts node content with AAD binding', () => {
        const dek = randomBytes(32);
        const plaintext = { role: 'user', text: 'hello world' };
        const encContent = encryptNodeContent(dek, 1, plaintext, aadBase);
        const dec = decryptNodeContent(dek, encContent, aadBase);
        assert.deepEqual(dec, plaintext);
    });

    it('detects tampered ciphertext', () => {
        const dek = randomBytes(32);
        const encContent = encryptNodeContent(dek, 1, { a: 1 }, aadBase);
        const tampered = { ...encContent, ct: String(encContent.ct).slice(0, -2) + 'AA' };
        assert.throws(() => decryptNodeContent(dek, tampered, aadBase));
    });

    it('detects wrong AAD (context id mismatch)', () => {
        const dek = randomBytes(32);
        const encContent = encryptNodeContent(dek, 1, { a: 1 }, aadBase);
        assert.throws(() => decryptNodeContent(dek, encContent, { ...aadBase, contextId: 'ctx_other' }));
    });

    it('keeps cleartext metadata index fields', () => {
        const dek = randomBytes(32);
        const meta = encryptNodeMetadata(
            dek,
            1,
            { source: 'claude', secret_note: 'hidden', project_path: '/tmp/p' },
            aadBase,
        );
        assert.equal(meta.source, 'claude');
        assert.equal(meta.project_path, '/tmp/p');
        assert.ok(meta.ic_sensitive);
        const dec = decryptNodeMetadata(dek, meta, aadBase);
        assert.equal(dec.secret_note, 'hidden');
    });
});

describe('multi-device unlock', () => {
    it('recovery wrap matches passphrase wrap', async () => {
        const material = await createVaultCryptoMaterial('primary-pass');
        const kekPass = await deriveVaultKek('primary-pass', material.kdfSalt);
        const dekA = unwrapDek(material.wrappedDekPassphrase, kekPass);
        const dekB = unwrapDek(material.wrappedDekRecovery, recoveryKeyToKek(material.recoveryKeyBytes));
        assert.deepEqual(dekA, dekB);
    });
});

describe('AEAD primitive vectors', () => {
    it('tamper fails on raw AEAD envelope', () => {
        const key = randomBytes(32);
        const aad = new TextEncoder().encode('aad');
        const env = encryptAead(key, new TextEncoder().encode('payload'), aad);
        env.ct = env.ct.slice(0, -4) + 'AAAA';
        assert.throws(() => decryptAead(key, env, aad));
    });
});
