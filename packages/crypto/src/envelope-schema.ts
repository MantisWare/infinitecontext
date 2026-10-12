import { AEAD_ALG } from './constants';
import { base64ToBytes } from './encoding';
import { ENCRYPTED_CONTENT_MARKER, isEncryptedContent } from './node-payload';

const NONCE_BYTES = 24;

const ALLOWED_ENVELOPE_KEYS = new Set(['__ic_enc', 'kid', 'v', 'alg', 'nonce', 'ct']);

export function assertStrictEncryptedEnvelope(value: unknown, label: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an encrypted envelope object`);
    }
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
        if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
            throw new Error(`${label} contains forbidden plaintext field: ${key}`);
        }
    }
    if (rec[ENCRYPTED_CONTENT_MARKER] !== 1) {
        throw new Error(`${label} missing encryption marker`);
    }
    if (typeof rec.kid !== 'string' || !/^dek_v\d+$/.test(rec.kid)) {
        throw new Error(`${label} has invalid kid`);
    }
    if (rec.v !== 1 || rec.alg !== AEAD_ALG) {
        throw new Error(`${label} has unsupported envelope version`);
    }
    if (typeof rec.nonce !== 'string' || typeof rec.ct !== 'string') {
        throw new Error(`${label} has invalid nonce or ciphertext`);
    }
    let nonceBytes: Uint8Array;
    try {
        nonceBytes = base64ToBytes(rec.nonce);
    } catch {
        throw new Error(`${label} has invalid nonce encoding`);
    }
    if (nonceBytes.length !== NONCE_BYTES) {
        throw new Error(`${label} nonce must be ${NONCE_BYTES} bytes`);
    }
}

export function validateEncryptedWriteShape(content: Record<string, unknown>, metadata: Record<string, unknown>): void {
    if (!isEncryptedContent(content)) {
        throw new Error('content must be encrypted');
    }
    assertStrictEncryptedEnvelope(content, 'content');
    const sensitive = metadata.ic_sensitive;
    if (sensitive !== undefined) {
        if (!sensitive || typeof sensitive !== 'object' || Array.isArray(sensitive)) {
            throw new Error('ic_sensitive must be an encrypted envelope');
        }
        assertStrictEncryptedEnvelope(sensitive, 'metadata.ic_sensitive');
    }
}
