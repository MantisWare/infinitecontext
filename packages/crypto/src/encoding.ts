import { sha256 } from '@noble/hashes/sha256';

const BASE64URL =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Crockford-like base32 without I/L/O/U for recovery key display. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const RECOVERY_CHECKSUM_BYTES = 2;

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function encodeBase32(data: Uint8Array): string {
    let bits = 0;
    let value = 0;
    const chars: string[] = [];
    for (const byte of data) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            const index = (value >> bits) & 31;
            chars.push(RECOVERY_ALPHABET[index]!);
        }
    }
    if (bits > 0) {
        chars.push(RECOVERY_ALPHABET[(value << (5 - bits)) & 31]!);
    }
    const grouped: string[] = [];
    for (let i = 0; i < chars.length; i += 4) {
        grouped.push(chars.slice(i, i + 4).join(''));
    }
    return grouped.join('-');
}

export function encodeRecoveryKey(raw: Uint8Array): string {
    if (raw.length !== 32) throw new Error('Recovery key must be 32 bytes');
    const checksum = sha256(raw).slice(0, RECOVERY_CHECKSUM_BYTES);
    const payload = new Uint8Array(raw.length + RECOVERY_CHECKSUM_BYTES);
    payload.set(raw, 0);
    payload.set(checksum, raw.length);
    return encodeBase32(payload);
}

export function decodeRecoveryKey(input: string): Uint8Array {
    const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of cleaned) {
        const idx = RECOVERY_ALPHABET.indexOf(ch);
        if (idx < 0) throw new Error('Invalid recovery key character');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >> bits) & 255);
        }
    }
    if (out.length === 32) {
        return new Uint8Array(out);
    }
    const payloadLen = 32 + RECOVERY_CHECKSUM_BYTES;
    if (out.length !== payloadLen) throw new Error('Invalid recovery key length');
    const payload = new Uint8Array(out);
    const raw = payload.slice(0, 32);
    const checksum = payload.slice(32);
    const expected = sha256(raw).slice(0, RECOVERY_CHECKSUM_BYTES);
    if (!constantTimeEqual(checksum, expected)) throw new Error('Invalid recovery key checksum');
    return raw;
}

export function randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
    return diff === 0;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
    const b64 = bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b64;
}
