import { sha256 } from "@noble/hashes/sha256";

import { assertStrictEncryptedEnvelope, base64ToBytes, isEncryptedContent } from "../ic-crypto.mjs";

/** Wire format version for objects written to StorageAdapter backends. */
export const STORAGE_OBJECT_VERSION = 1;

const ALLOWED_STORAGE_OBJECT_KEYS = new Set(["ic_storage_v", "aad", "enc"]);
const STORAGE_AAD_PATTERN = /^ic-storage\|[^|]+\|[^|]+\|\d+$/;
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * @param {string} aad
 */
export function isValidStorageAad(aad) {
  return typeof aad === "string" && STORAGE_AAD_PATTERN.test(aad);
}

/**
 * @param {string} aad e.g. ic-storage|log|devH|seq
 * @param {Record<string, unknown>} envelope strict __ic_enc envelope
 */
export function buildStorageObjectBytes(aad, envelope) {
  if (!isValidStorageAad(aad)) {
    throw new Error("Invalid storage AAD (expected ic-storage|log|devH|seq)");
  }
  assertStrictEncryptedEnvelope(envelope, "enc");
  rejectPlaintextInCiphertextField(String(envelope.ct ?? ""));
  const json = JSON.stringify({
    ic_storage_v: STORAGE_OBJECT_VERSION,
    aad,
    enc: envelope,
  });
  return new TextEncoder().encode(json);
}

/**
 * Storage backends must only persist ciphertext bytes (strict storage object or opaque binary with AAD envelope).
 * @param {unknown} body
 */
export function assertStorageCiphertext(body) {
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("Storage put body must be Uint8Array ciphertext");
  }
  if (body.length === 0) {
    throw new Error("Storage rejects empty put body");
  }
  if (body.length >= 2 && body[0] === GZIP_MAGIC[0] && body[1] === GZIP_MAGIC[1]) {
    throw new Error("Storage rejects gzip-compressed plaintext payloads");
  }

  const text = tryDecodeUtf8(body);
  if (text === null) {
    throw new Error("Storage rejects opaque binary without ic_storage object wrapper");
  }

  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) {
    throw new Error("Storage rejects non-object UTF-8 payloads");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Storage rejects invalid JSON payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Storage rejects non-object JSON payloads");
  }

  assertStorageObjectRecord(parsed);
}

/**
 * @param {Record<string, unknown>} record
 */
function assertStorageObjectRecord(record) {
  for (const key of Object.keys(record)) {
    if (!ALLOWED_STORAGE_OBJECT_KEYS.has(key)) {
      throw new Error(`Storage object contains forbidden field: ${key}`);
    }
  }
  if (record.ic_storage_v !== STORAGE_OBJECT_VERSION) {
    throw new Error("Storage object has unsupported ic_storage_v");
  }
  const aad = record.aad;
  if (!isValidStorageAad(aad)) {
    throw new Error("Storage object aad must match ic-storage|log|devH|seq");
  }
  const enc = record.enc;
  if (!isEncryptedContent(enc)) {
    throw new Error("Storage object enc must be an encrypted envelope");
  }
  assertStrictEncryptedEnvelope(enc, "enc");
  rejectPlaintextInCiphertextField(String(enc.ct ?? ""));
}

/** @param {string} ctB64 */
function rejectPlaintextInCiphertextField(ctB64) {
  let ctBytes;
  try {
    ctBytes = base64ToBytes(ctB64);
  } catch {
    throw new Error("Storage enc.ct has invalid base64");
  }
  if (ctBytes.length === 0) {
    return;
  }
  const asText = tryDecodeUtf8(ctBytes);
  if (asText === null) {
    return;
  }
  const compact = asText.trim();
  if (compact.startsWith("{") || compact.startsWith("[") || /^[\x20-\x7e]+$/.test(compact)) {
    throw new Error("Storage enc.ct appears to embed plaintext");
  }
}

/** @param {Uint8Array} bytes */
function tryDecodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** @param {Uint8Array} body */
export function storageObjectDigest(body) {
  return sha256(body);
}
