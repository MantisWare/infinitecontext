import { xchacha20poly1305 } from '@noble/ciphers/chacha';

import { AEAD_ALG } from './constants';
import { base64ToBytes, bytesToBase64, randomBytes } from './encoding';

export type AeadEnvelope = {
    v: 1;
    alg: typeof AEAD_ALG;
    nonce: string;
    ct: string;
};

export function encryptAead(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): AeadEnvelope {
    const nonce = randomBytes(24);
    const cipher = xchacha20poly1305(key, nonce, aad);
    const ct = cipher.encrypt(plaintext);
    return {
        v: 1,
        alg: AEAD_ALG,
        nonce: bytesToBase64(nonce),
        ct: bytesToBase64(ct),
    };
}

export class DecryptionFailedError extends Error {
    constructor(message = 'Decryption failed — wrong key, tampered data, or corrupted ciphertext.') {
        super(message);
        this.name = 'DecryptionFailedError';
    }
}

export function decryptAead(key: Uint8Array, envelope: AeadEnvelope, aad: Uint8Array): Uint8Array {
    if (envelope.v !== 1 || envelope.alg !== AEAD_ALG) {
        throw new DecryptionFailedError('Unsupported AEAD envelope');
    }
    const nonce = base64ToBytes(envelope.nonce);
    const ct = base64ToBytes(envelope.ct);
    const cipher = xchacha20poly1305(key, nonce, aad);
    try {
        return cipher.decrypt(ct);
    } catch {
        throw new DecryptionFailedError();
    }
}
