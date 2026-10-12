import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

import { bytesToBase64, base64ToBytes, constantTimeEqual } from './encoding';

const DEK_PROOF_LABEL = new TextEncoder().encode('infinitecontext/dek-proof/v1');

export function computeDekProof(dek: Uint8Array): Uint8Array {
    return hmac(sha256, dek, DEK_PROOF_LABEL);
}

export function dekProofToBase64(dek: Uint8Array): string {
    return bytesToBase64(computeDekProof(dek));
}

export function verifyDekProof(dek: Uint8Array, proofBase64: string): boolean {
    try {
        const expected = computeDekProof(dek);
        const actual = base64ToBytes(proofBase64);
        return constantTimeEqual(expected, actual);
    } catch {
        return false;
    }
}

export function verifyDekProofBytes(dek: Uint8Array, proofTag: Uint8Array): boolean {
    return constantTimeEqual(computeDekProof(dek), proofTag);
}
