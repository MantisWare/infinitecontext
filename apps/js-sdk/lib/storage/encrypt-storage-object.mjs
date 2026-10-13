import { sha256 } from "@noble/hashes/sha256";
import { timingSafeEqual } from "node:crypto";

import { encryptAead } from "../ic-crypto.mjs";
import { buildStorageAadForKey, buildStorageObjectBytes, normalizeStorageObjectKey } from "./ciphertext.mjs";

const STORAGE_DEK_BYTES = 32;

/** @type {WeakMap<Uint8Array, Uint8Array>} Digest captured when body leaves encryptVaultPlaintextForStoragePut */
const sealedPutBodyDigests = new WeakMap();

/**
 * @param {Uint8Array} dek
 */
function assertValidStorageEncryptionKey(dek) {
  if (!(dek instanceof Uint8Array) || dek.length !== STORAGE_DEK_BYTES) {
    throw new TypeError(`storage encryption key must be a ${STORAGE_DEK_BYTES}-byte Uint8Array`);
  }
  for (let i = 0; i < dek.length; i += 1) {
    if (dek[i] !== 0) {
      return;
    }
  }
  throw new Error("storage encryption key must not be all-zero");
}

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
function digestMatchesSealedBody(body, expectedDigest) {
  const actual = sha256(body);
  return expectedDigest.length === actual.length && timingSafeEqual(expectedDigest, actual);
}

export function assertStoragePutBodySealed(body) {
  if (!(body instanceof Uint8Array)) {
    throw new Error("Storage put body must be produced by encryptVaultPlaintextForStoragePut");
  }
  const expected = sealedPutBodyDigests.get(body);
  if (!expected) {
    throw new Error("Storage put body must be produced by encryptVaultPlaintextForStoragePut");
  }
  if (!digestMatchesSealedBody(body, expected)) {
    throw new Error("Storage put body was modified after encryption");
  }
}

/**
 * Immutable snapshot for adapter.put after seal verification on the caller buffer.
 * @param {Uint8Array} sealedBody
 */
export function copyVerifiedStoragePutBodyForAdapter(sealedBody) {
  assertStoragePutBodySealed(sealedBody);
  const expected = sealedPutBodyDigests.get(sealedBody);
  const copy = new Uint8Array(sealedBody);
  if (!expected || !digestMatchesSealedBody(copy, expected)) {
    throw new Error("Storage put body was modified after encryption");
  }
  return copy;
}

/**
 * Encrypt plaintext with DEK and wrap as a sealed storage object (vault encrypt path).
 * @param {Uint8Array} dek
 * @param {string} objectKey
 * @param {unknown} plaintext JSON-serializable plaintext payload
 * @param {{ seq?: number, dekVersion?: number }} [options]
 */
export function encryptVaultPlaintextForStoragePut(dek, objectKey, plaintext, options = {}) {
  assertValidStorageEncryptionKey(dek);
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
