import { xchacha20poly1305 } from "@noble/ciphers/chacha";

import { AEAD_ALG, bytesToBase64 } from "../../lib/ic-crypto.mjs";
import {
  assertDevH,
  buildLayoutLogSegmentAad,
  padSegmentPlaintext,
  serializeLogSegmentRecord,
} from "../../lib/storage/layout.mjs";

/**
 * Deterministic log segment encryption for test vectors only.
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {import("../../lib/storage/layout.mjs").LayoutLogSegmentRecord} record
 * @param {Uint8Array} nonce
 */
export function encryptLogSegmentWithFixedNonceForTests(dek, devH, record, nonce) {
  assertDevH(devH);
  if (nonce.length !== 24) {
    throw new Error("AEAD nonce must be 24 bytes");
  }
  const aad = buildLayoutLogSegmentAad(devH, record.seq);
  const padded = padSegmentPlaintext(serializeLogSegmentRecord(record));
  const ct = xchacha20poly1305(dek, nonce, aad).encrypt(padded);
  return {
    v: 1,
    alg: AEAD_ALG,
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ct),
  };
}
