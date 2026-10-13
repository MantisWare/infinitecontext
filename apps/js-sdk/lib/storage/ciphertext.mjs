import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import { AEAD_ALG, assertStrictEncryptedEnvelope, base64ToBytes, isEncryptedContent } from "../ic-crypto.mjs";

/** Wire format version for objects written to StorageAdapter backends. */
export const STORAGE_OBJECT_VERSION = 1;

/** XChaCha20-Poly1305: ct field holds ciphertext || 16-byte Poly1305 tag (nonce is separate). */
export const XC20P_POLY1305_TAG_BYTES = 16;

const ALLOWED_STORAGE_OBJECT_KEYS = new Set(["ic_storage_v", "aad", "enc"]);
const STORAGE_AAD_PATTERN = /^ic-storage\|[a-z0-9._-]+\|[0-9a-f]{16}\|\d+$/;
const GZIP_MAGIC = [0x1f, 0x8b];

const PLAINTEXT_LEAK_KEY_PATTERN = /password|secret|plaintext|message|title|email|token/i;

/** @param {string} key */
export function normalizeStorageObjectKey(key) {
  const normalized = String(key ?? "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid storage object key");
  }
  return normalized;
}

/**
 * Strict AAD grammar bound to object key: ic-storage|log|devH|seq
 * devH = first 8 bytes of sha256(key) as hex (16 chars).
 * @param {string} objectKey
 * @param {number} [seq]
 */
export function buildStorageAadForKey(objectKey, seq = 0) {
  const normalized = normalizeStorageObjectKey(objectKey);
  const log = normalized.split("/")[0] ?? "object";
  if (!/^[a-z0-9._-]+$/i.test(log)) {
    throw new Error("Storage AAD log segment invalid");
  }
  const devH = bytesToHex(sha256(new TextEncoder().encode(normalized)).slice(0, 8));
  const aad = `ic-storage|${log}|${devH}|${seq}`;
  if (!isValidStorageAad(aad)) {
    throw new Error("Failed to build storage AAD");
  }
  return aad;
}

/**
 * @param {string} aad
 */
export function isValidStorageAad(aad) {
  return typeof aad === "string" && STORAGE_AAD_PATTERN.test(aad);
}

/**
 * @param {string} aad
 * @param {string} objectKey
 */
export function assertStorageAadMatchesKey(aad, objectKey) {
  if (!isValidStorageAad(aad)) {
    throw new Error("Storage object aad must match ic-storage|log|devH|seq");
  }
  const normalized = normalizeStorageObjectKey(objectKey);
  const expectedPrefix = buildStorageAadForKey(normalized, Number(aad.split("|").pop()));
  if (aad !== expectedPrefix) {
    throw new Error("Storage object aad does not match object key binding");
  }
}

/**
 * @param {Record<string, unknown>} envelope
 */
export function assertXc20pCtLength(envelope) {
  if (envelope.alg !== AEAD_ALG) {
    throw new Error("Storage enc must use XC20P");
  }
  let ctBytes;
  try {
    ctBytes = base64ToBytes(String(envelope.ct ?? ""));
  } catch {
    throw new Error("Storage enc.ct has invalid base64");
  }
  if (ctBytes.length < XC20P_POLY1305_TAG_BYTES) {
    throw new Error(`Storage enc.ct must be at least ${XC20P_POLY1305_TAG_BYTES} bytes (ciphertext + Poly1305 tag)`);
  }
  rejectJsonPlaintextInCtBytes(ctBytes);
}

/** @param {Uint8Array} ctBytes */
function rejectJsonPlaintextInCtBytes(ctBytes) {
  const asText = tryDecodeUtf8(ctBytes);
  if (asText === null) {
    return;
  }
  const trimmed = asText.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return;
  }
  try {
    JSON.parse(asText);
  } catch {
    return;
  }
  throw new Error("Storage enc.ct must not contain JSON plaintext");
}

/**
 * @param {string} objectKey
 * @param {Record<string, unknown>} envelope strict __ic_enc envelope
 * @param {{ seq?: number }} [options]
 */
export function buildStorageObjectBytes(objectKey, envelope, options = {}) {
  const seq = options.seq ?? 0;
  const aad = buildStorageAadForKey(objectKey, seq);
  assertStrictEncryptedEnvelope(envelope, "enc");
  assertXc20pCtLength(envelope);
  const json = JSON.stringify({
    ic_storage_v: STORAGE_OBJECT_VERSION,
    aad,
    enc: envelope,
  });
  return new TextEncoder().encode(json);
}

/**
 * @param {Uint8Array} body
 * @returns {Record<string, unknown>}
 */
export function parseStorageObject(body) {
  assertStorageCiphertext(body);
  const text = new TextDecoder("utf-8").decode(body);
  return JSON.parse(text);
}

/**
 * @param {Uint8Array} body
 * @param {string} objectKey
 */
export function verifyStorageObjectForKey(body, objectKey) {
  const record = parseStorageObject(body);
  assertStorageObjectRecord(record);
  assertStorageAadMatchesKey(String(record.aad), objectKey);
  return record;
}

/**
 * @param {unknown} body
 * @param {{ objectKey?: string }} [options]
 */
export function assertStorageCiphertext(body, options = {}) {
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
  if (options.objectKey !== undefined) {
    assertStorageAadMatchesKey(String(parsed.aad), options.objectKey);
  }
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
  if (typeof aad !== "string" || !isValidStorageAad(aad)) {
    throw new Error("Storage object aad must match ic-storage|log|devH|seq");
  }
  const enc = record.enc;
  if (!isEncryptedContent(enc)) {
    throw new Error("Storage object enc must be an encrypted envelope");
  }
  assertStrictEncryptedEnvelope(enc, "enc");
  assertXc20pCtLength(enc);
}

/** @param {Uint8Array} body */
export function storageObjectDigest(body) {
  return sha256(body);
}

/** @param {string} key @param {Uint8Array} body */
export function scanStorageObjectForLeaks(key, body) {
  if (PLAINTEXT_LEAK_KEY_PATTERN.test(key)) {
    throw new Error(`Storage key appears to leak plaintext metadata: ${key}`);
  }
  const record = parseStorageObject(body);
  const serialized = JSON.stringify(record);
  if (PLAINTEXT_LEAK_KEY_PATTERN.test(serialized)) {
    throw new Error("Storage object JSON appears to contain sensitive plaintext fields");
  }
  if (record.aad === undefined || record.aad === null || record.aad === "") {
    throw new Error("Storage object missing aad at rest");
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
