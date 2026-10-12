import { WRAP_ALG } from './constants';
import { decryptAead, encryptAead, type AeadEnvelope } from './aead';

export type WrappedDekRecord = {
    v: 1;
    alg: typeof WRAP_ALG;
    envelope: AeadEnvelope;
};

const WRAP_AAD = new TextEncoder().encode('infinitecontext/dek-wrap/v1');

export function wrapDek(dek: Uint8Array, kek: Uint8Array): Uint8Array {
    const envelope = encryptAead(kek, dek, WRAP_AAD);
    const record: WrappedDekRecord = { v: 1, alg: WRAP_ALG, envelope };
    return new TextEncoder().encode(JSON.stringify(record));
}

export function unwrapDek(wrapped: Uint8Array, kek: Uint8Array): Uint8Array {
    let parsed: WrappedDekRecord;
    try {
        parsed = JSON.parse(new TextDecoder().decode(wrapped)) as WrappedDekRecord;
    } catch {
        throw new Error('Invalid wrapped DEK format');
    }
    if (parsed.v !== 1 || parsed.alg !== WRAP_ALG) throw new Error('Unsupported wrapped DEK version');
    return decryptAead(kek, parsed.envelope, WRAP_AAD);
}

export function wrappedDekToBuffer(wrapped: Uint8Array): Buffer {
    return Buffer.from(wrapped);
}

export function bufferToWrappedDek(buf: Buffer | null | undefined): Uint8Array | null {
    if (!buf?.length) return null;
    return new Uint8Array(buf);
}
