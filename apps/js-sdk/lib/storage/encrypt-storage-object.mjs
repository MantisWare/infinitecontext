import { sha256 } from "@noble/hashes/sha256";
import { timingSafeEqual } from "node:crypto";

import { encryptAead } from "../ic-crypto.mjs";
import { buildStorageAadForKey, buildStorageObjectBytes, normalizeStorageObjectKey } from "./ciphertext.mjs";

/** @type {WeakMap<Uint8Array, Uint8Array>} Digest captured when body leaves encryptVaultPlaintextForStoragePut */
const sealedPutBodyDigests = new WeakMap();

/**
 * @param {Uint8Array} body
 */
function sealVaultEncryptPutBody(body) {
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("sealed storage body must be Uint8Array");
  }
  sealedPutBodyDigests.set(body, sha256(body));
}

/**
 * @param {Uint8Array} body
 */
export function assertStoragePutBodySealed(body) {
  if (!(body instanceof Uint8Array)) {
    throw new Error("Storage put body must be produced by encryptVaultPlaintextForStoragePut");
  }
  const expected = sealedPutBodyDigests.get(body);
  if (!expected) {
    throw new Error("Storage put body must be produced by encryptVaultPlaintextForStoragePut");
  }
  const actual = sha256(body);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Storage put body was modified after encryption");
  }
}

/**
 * Encrypt plaintext with DEK and wrap as a sealed storage object (vault encrypt path).
 * @param {Uint8Array} dek
 * @param {string} objectKey
 * @param {unknown} plaintext JSON-serializable plaintext payload
 * @param {{ seq?: number, dekVersion?: number }} [options]
 */
export function encryptVaultPlaintextForStoragePut(dek, objectKey, plaintext, options = {}) {
  const normalized = normalizeStorageObjectKey(objectKey);
  const aadString = buildStorageAadForKey(normalized, options.seq ?? 0);
  const aadBytes = new TextEncoder().encode(aadString);
  const encrypted = encryptAead(dek, new TextEncoder().encode(JSON.stringify(plaintext)), aadBytes);
  const body = buildStorageObjectBytes(
    normalized,
    {
      __ic_enc: 1,
      kid: `dek_v${options.dekVersion ?? 1}`,
      v: encrypted.v,
      alg: encrypted.alg,
      nonce: encrypted.nonce,
      ct: encrypted.ct,
    },
    { seq: options.seq ?? 0 },
  );
  sealVaultEncryptPutBody(body);
  return body;
}
