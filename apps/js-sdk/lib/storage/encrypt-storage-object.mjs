import { encryptAead } from "../ic-crypto.mjs";
import { buildStorageAadForKey, buildStorageObjectBytes, normalizeStorageObjectKey } from "./ciphertext.mjs";

/** @type {WeakSet<Uint8Array>} */
const sealedPutBodies = new WeakSet();

/**
 * Mark bytes as produced by the vault/storage encrypt path (ObjectStoreSyncTransport contract).
 * @param {Uint8Array} body
 */
export function markStoragePutBodySealed(body) {
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("sealed storage body must be Uint8Array");
  }
  sealedPutBodies.add(body);
}

/**
 * @param {Uint8Array} body
 */
export function assertStoragePutBodySealed(body) {
  if (!(body instanceof Uint8Array) || !sealedPutBodies.has(body)) {
    throw new Error("Storage put body must be produced by encryptStorageObjectForPut");
  }
}

/**
 * Build a storage object from an already-encrypted envelope (tests / callers with vault crypto).
 * @param {string} objectKey
 * @param {Record<string, unknown>} envelope
 * @param {{ seq?: number }} [options]
 */
export function encryptStorageObjectForPut(objectKey, envelope, options = {}) {
  const body = buildStorageObjectBytes(objectKey, envelope, options);
  markStoragePutBodySealed(body);
  return body;
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
  markStoragePutBodySealed(body);
  return body;
}
