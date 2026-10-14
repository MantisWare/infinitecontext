import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import {
  AEAD_ALG,
  DecryptionFailedError,
  VAULT_KDF_PARAMS,
  base64ToBytes,
  bytesToBase64,
  decryptAead,
  encryptAead,
  parseWrappedDekRecord,
  serializeKdfParams,
  wrapDek,
} from "../ic-crypto.mjs";

export const IC_LAYOUT_DIR = "ic-v1";
export const IC_VAULT_JSON_VERSION = 1;
export const IC_LAYOUT_LOG_AAD_VERSION = "v1";
export const NAMING_KEY_INFO = "ic-storage-names-v1";
export const SEGMENT_BUCKET_BYTES = 4096;
export const DEVH_BYTES = 16;
export const MAX_SEGMENT_BUCKETS = 64;

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEVH_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const VAULT_KDF_FIELD_NAMES = new Set([
  "algorithm",
  "memorySizeKiB",
  "iterations",
  "parallelism",
  "hashLength",
]);
const WRAPPED_DEK_FIELD_NAMES = new Set(["v", "alg", "envelope"]);
const SEGMENT_RECORD_FIELD_NAMES = new Set([
  "dev",
  "seq",
  "prev_digest",
  "created_at",
  "mutations",
]);
const VAULT_JSON_FIELD_NAMES = new Set([
  "ic_vault_v",
  "kdf",
  "kdf_salt_b64",
  "wrapped_dek_b64",
]);

/** @typedef {import("../ic-crypto.mjs").AeadEnvelope} AeadEnvelope */

/**
 * @typedef {Object} LayoutLogSegmentRecord
 * @property {string} dev device UUID (canonical lowercase)
 * @property {number} seq
 * @property {string} prev_digest hex sha256 of previous segment envelope JSON (empty at seq 0)
 * @property {string} created_at ISO-8601
 * @property {unknown[]} mutations
 */

export class LayoutIntegrityError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LayoutIntegrityError";
    this.code = "layout_integrity";
  }
}

export class LayoutPaddingError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LayoutPaddingError";
    this.code = "layout_padding";
  }
}

/**
 * @param {string} deviceUuid
 */
export function normalizeDeviceUuid(deviceUuid) {
  const trimmed = String(deviceUuid ?? "").trim().toLowerCase();
  if (!DEVICE_UUID_PATTERN.test(trimmed)) {
    throw new Error("Invalid device UUID");
  }
  return trimmed;
}

/**
 * @param {string} devH
 */
export function assertDevH(devH) {
  const value = String(devH ?? "");
  if (!DEVH_PATTERN.test(value)) {
    throw new Error("devH must be 26-character Crockford base32");
  }
  return value;
}

/**
 * @param {string} prefix
 */
export function normalizeLayoutPrefix(prefix) {
  const trimmed = String(prefix ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("..")) {
    throw new Error("Invalid layout prefix");
  }
  return trimmed;
}

/**
 * @param {string} prefix
 */
export function layoutRootPath(prefix) {
  return `${normalizeLayoutPrefix(prefix)}/${IC_LAYOUT_DIR}`;
}

/** @param {string} prefix */
export function vaultJsonRelativePath(prefix) {
  return `${layoutRootPath(prefix)}/vault.json`;
}

/** @param {string} prefix */
export function manifestEncRelativePath(prefix) {
  return `${layoutRootPath(prefix)}/manifest.json.enc`;
}

/** @param {string} prefix @param {string} devH */
export function deviceEncRelativePath(prefix, devH) {
  assertDevH(devH);
  return `${layoutRootPath(prefix)}/devices/${devH}.json.enc`;
}

/** @param {string} prefix @param {string} devH @param {number} seq */
export function logSegmentRelativePath(prefix, devH, seq) {
  assertDevH(devH);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("Log segment seq must be a non-negative safe integer");
  }
  return `${layoutRootPath(prefix)}/log/${devH}/${String(seq).padStart(12, "0")}.enc`;
}

/** @param {string} prefix @param {number} epoch */
export function snapEncRelativePath(prefix, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("Snapshot epoch must be a non-negative safe integer");
  }
  return `${layoutRootPath(prefix)}/snap/${String(epoch).padStart(8, "0")}.enc`;
}

/** @param {string} prefix @param {string} lockName */
export function lockRelativePath(prefix, lockName) {
  const name = String(lockName ?? "").trim();
  if (!name || name.includes("/") || name.includes("..")) {
    throw new Error("Invalid lock name");
  }
  return `${layoutRootPath(prefix)}/lock/${name}.lock`;
}

/**
 * @param {Uint8Array} bytes
 */
export function encodeCrockfordBase32(bytes) {
  let bits = 0;
  let value = 0;
  /** @type {string[]} */
  const chars = [];
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars.push(CROCKFORD_BASE32[(value >> bits) & 31]);
    }
  }
  if (bits > 0) {
    chars.push(CROCKFORD_BASE32[(value << (5 - bits)) & 31]);
  }
  return chars.join("");
}

/**
 * @param {Uint8Array} dek 32-byte storage DEK
 */
export function deriveNamingKey(dek) {
  if (!(dek instanceof Uint8Array) || dek.length !== 32) {
    throw new TypeError("DEK must be a 32-byte Uint8Array");
  }
  return hkdf(sha256, dek, undefined, new TextEncoder().encode(NAMING_KEY_INFO), 32);
}

/**
 * @param {Uint8Array} dek
 * @param {string} deviceUuid
 */
export function deriveDevH(dek, deviceUuid) {
  const dev = normalizeDeviceUuid(deviceUuid);
  const namingKey = deriveNamingKey(dek);
  const mac = hmac(sha256, namingKey, new TextEncoder().encode(dev));
  return encodeCrockfordBase32(mac.slice(0, DEVH_BYTES));
}

/**
 * @param {string} devH
 * @param {number} seq
 */
export function buildLayoutLogSegmentAad(devH, seq) {
  assertDevH(devH);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("seq must be a non-negative safe integer");
  }
  return new TextEncoder().encode(
    `ic-storage|${IC_LAYOUT_LOG_AAD_VERSION}|log|${devH}|${seq}`,
  );
}

/**
 * @param {string} jsonText
 */
export function padSegmentPlaintext(jsonText) {
  const body = new TextEncoder().encode(jsonText);
  const total = 4 + body.length;
  const buckets = Math.max(1, Math.ceil(total / SEGMENT_BUCKET_BYTES));
  if (buckets > MAX_SEGMENT_BUCKETS) {
    throw new LayoutPaddingError(
      `Segment plaintext exceeds ${MAX_SEGMENT_BUCKETS} buckets (${MAX_SEGMENT_BUCKETS * SEGMENT_BUCKET_BYTES} bytes)`,
    );
  }
  const padded = new Uint8Array(buckets * SEGMENT_BUCKET_BYTES);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(0, body.length, false);
  padded.set(body, 4);
  return padded;
}

/**
 * @param {Uint8Array} paddedPlaintext
 */
export function unpadSegmentPlaintext(paddedPlaintext) {
  if (paddedPlaintext.length === 0 || paddedPlaintext.length % SEGMENT_BUCKET_BYTES !== 0) {
    throw new LayoutPaddingError("Decrypted segment length is not a multiple of bucket size");
  }
  const view = new DataView(
    paddedPlaintext.buffer,
    paddedPlaintext.byteOffset,
    paddedPlaintext.byteLength,
  );
  const declaredLen = view.getUint32(0, false);
  if (declaredLen > paddedPlaintext.length - 4) {
    throw new LayoutPaddingError("Segment length prefix exceeds bucket capacity");
  }
  const slice = paddedPlaintext.slice(4, 4 + declaredLen);
  return new TextDecoder().decode(slice);
}

/**
 * @param {LayoutLogSegmentRecord} record
 */
export function serializeLogSegmentRecord(record) {
  for (const key of Object.keys(record)) {
    if (!SEGMENT_RECORD_FIELD_NAMES.has(key)) {
      throw new Error(`Log segment record contains forbidden field: ${key}`);
    }
  }
  const dev = normalizeDeviceUuid(record.dev);
  if (!Number.isSafeInteger(record.seq) || record.seq < 0) {
    throw new Error("Log segment record seq invalid");
  }
  return JSON.stringify({
    dev,
    seq: record.seq,
    prev_digest: record.prev_digest,
    created_at: record.created_at,
    mutations: record.mutations,
  });
}

/**
 * @param {string} jsonText
 */
export function parseLogSegmentRecord(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Log segment record must be an object");
  }
  for (const key of Object.keys(parsed)) {
    if (!SEGMENT_RECORD_FIELD_NAMES.has(key)) {
      throw new Error(`Log segment record contains forbidden field: ${key}`);
    }
  }
  if (typeof parsed.prev_digest !== "string" || typeof parsed.created_at !== "string") {
    throw new Error("Log segment record missing prev_digest or created_at");
  }
  if (!Number.isSafeInteger(parsed.seq) || parsed.seq < 0) {
    throw new Error("Log segment record seq invalid");
  }
  if (!Array.isArray(parsed.mutations)) {
    throw new Error("Log segment record missing mutations");
  }
  const dev = normalizeDeviceUuid(parsed.dev);
  return /** @type {LayoutLogSegmentRecord} */ ({
    dev,
    seq: parsed.seq,
    prev_digest: parsed.prev_digest,
    created_at: parsed.created_at,
    mutations: parsed.mutations,
  });
}

/**
 * @param {AeadEnvelope} envelope
 */
export function layoutSegmentEnvelopeDigest(envelope) {
  const canonical = JSON.stringify({
    v: envelope.v,
    alg: envelope.alg,
    nonce: envelope.nonce,
    ct: envelope.ct,
  });
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/**
 * @param {Uint8Array} key
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} aad
 * @param {Uint8Array} nonce 24-byte nonce (tests only)
 */
function encryptAeadWithFixedNonce(key, plaintext, aad, nonce) {
  if (nonce.length !== 24) {
    throw new Error("AEAD nonce must be 24 bytes");
  }
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return {
    v: 1,
    alg: AEAD_ALG,
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ct),
  };
}

/**
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {LayoutLogSegmentRecord} record
 */
export function encryptLogSegment(dek, devH, record) {
  assertDevH(devH);
  if (record.seq !== 0 && !record.prev_digest) {
    throw new Error("Non-genesis log segments require prev_digest");
  }
  const aad = buildLayoutLogSegmentAad(devH, record.seq);
  const padded = padSegmentPlaintext(serializeLogSegmentRecord(record));
  return encryptAead(dek, padded, aad);
}

/**
 * Test-only: fixed nonce for deterministic vectors (not exported from storage/index.mjs).
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {LayoutLogSegmentRecord} record
 * @param {Uint8Array} nonce
 */
export function encryptLogSegmentWithFixedNonceForTests(dek, devH, record, nonce) {
  assertDevH(devH);
  const aad = buildLayoutLogSegmentAad(devH, record.seq);
  const padded = padSegmentPlaintext(serializeLogSegmentRecord(record));
  return encryptAeadWithFixedNonce(dek, padded, aad, nonce);
}

/**
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {number} seq
 * @param {AeadEnvelope} envelope
 */
export function decryptLogSegment(dek, devH, seq, envelope) {
  assertDevH(devH);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new LayoutIntegrityError("Path seq must be a non-negative safe integer");
  }
  const aad = buildLayoutLogSegmentAad(devH, seq);
  const padded = decryptAead(dek, envelope, aad);
  if (padded.length === 0 || padded.length % SEGMENT_BUCKET_BYTES !== 0) {
    throw new LayoutPaddingError("Decrypted segment has invalid padded length");
  }
  const record = parseLogSegmentRecord(unpadSegmentPlaintext(padded));
  if (record.seq !== seq) {
    throw new LayoutIntegrityError(
      `Segment seq mismatch (path ${seq}, payload ${record.seq})`,
    );
  }
  if (deriveDevH(dek, record.dev) !== devH) {
    throw new LayoutIntegrityError("Segment devH does not match device UUID in record");
  }
  return record;
}

/**
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {{ seq: number, envelope: AeadEnvelope }[]} orderedSegments ascending by seq
 * @param {{ seq: number, digest: string }} expectedHead anchored log head
 */
export function verifyLogSegmentChain(dek, devH, orderedSegments, expectedHead) {
  assertDevH(devH);
  if (!expectedHead || !Number.isSafeInteger(expectedHead.seq) || expectedHead.seq < 0) {
    throw new LayoutIntegrityError("expectedHead.seq must be a non-negative safe integer");
  }
  if (typeof expectedHead.digest !== "string" || !/^[0-9a-f]{64}$/.test(expectedHead.digest)) {
    throw new LayoutIntegrityError("expectedHead.digest must be a 64-char hex sha256");
  }
  if (orderedSegments.length === 0) {
    throw new LayoutIntegrityError("Empty log chain");
  }
  if (orderedSegments.length !== expectedHead.seq + 1) {
    throw new LayoutIntegrityError("Truncated or extended log chain");
  }
  for (let i = 0; i < orderedSegments.length; i += 1) {
    if (orderedSegments[i].seq !== i) {
      throw new LayoutIntegrityError("Log chain gap, reorder, or fork");
    }
  }
  const last = orderedSegments[orderedSegments.length - 1];
  if (layoutSegmentEnvelopeDigest(last.envelope) !== expectedHead.digest) {
    throw new LayoutIntegrityError("Log head digest mismatch (rollback or fork)");
  }

  /** @type {string | null} */
  let expectedPrev = null;
  for (const row of orderedSegments) {
    const record = decryptLogSegment(dek, devH, row.seq, row.envelope);
    if (expectedPrev === null) {
      if (record.seq !== 0 || record.prev_digest !== "") {
        throw new LayoutIntegrityError("Genesis segment must have seq 0 and empty prev_digest");
      }
    } else if (record.prev_digest !== expectedPrev) {
      throw new LayoutIntegrityError("Log segment prev_digest mismatch (reorder or tamper)");
    }
    expectedPrev = layoutSegmentEnvelopeDigest(row.envelope);
  }
  return true;
}

/**
 * @param {Record<string, unknown>} kdf
 */
export function parseStrictVaultKdfParams(kdf) {
  if (!kdf || typeof kdf !== "object" || Array.isArray(kdf)) {
    throw new Error("vault.json kdf must be an object");
  }
  for (const key of Object.keys(kdf)) {
    if (!VAULT_KDF_FIELD_NAMES.has(key)) {
      throw new Error(`vault.json kdf contains forbidden field: ${key}`);
    }
  }
  if (kdf.algorithm !== VAULT_KDF_PARAMS.algorithm) {
    throw new Error("vault.json kdf algorithm must be argon2id");
  }
  const memorySizeKiB = Number(kdf.memorySizeKiB);
  const iterations = Number(kdf.iterations);
  const parallelism = Number(kdf.parallelism);
  const hashLength = Number(kdf.hashLength);
  if (!Number.isSafeInteger(memorySizeKiB) || memorySizeKiB < VAULT_KDF_PARAMS.memorySizeKiB) {
    throw new Error("vault.json kdf memorySizeKiB below minimum");
  }
  if (!Number.isSafeInteger(iterations) || iterations < VAULT_KDF_PARAMS.iterations) {
    throw new Error("vault.json kdf iterations below minimum");
  }
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 8) {
    throw new Error("vault.json kdf parallelism out of range");
  }
  if (hashLength !== VAULT_KDF_PARAMS.hashLength) {
    throw new Error("vault.json kdf hashLength must be 32");
  }
  return {
    algorithm: "argon2id",
    memorySizeKiB,
    iterations,
    parallelism,
    hashLength,
  };
}

/**
 * @param {Uint8Array} wrappedDekBytes
 */
export function parseStrictWrappedDekBytes(wrappedDekBytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(wrappedDekBytes));
  } catch {
    throw new Error("Invalid wrapped DEK format");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid wrapped DEK format");
  }
  for (const key of Object.keys(parsed)) {
    if (!WRAPPED_DEK_FIELD_NAMES.has(key)) {
      throw new Error(`wrapped DEK contains forbidden field: ${key}`);
    }
  }
  return parseWrappedDekRecord(wrappedDekBytes);
}

/**
 * @param {Uint8Array} wrappedDekBytes from wrapDek()
 * @param {Uint8Array} kdfSalt 16-byte salt
 * @param {Record<string, unknown>} [kdfParams]
 */
export function encodeVaultJson(wrappedDekBytes, kdfSalt, kdfParams = serializeKdfParams()) {
  parseStrictWrappedDekBytes(wrappedDekBytes);
  if (!(kdfSalt instanceof Uint8Array) || kdfSalt.length !== VAULT_KDF_PARAMS.saltLength) {
    throw new Error("vault.json kdf salt must be 16 bytes");
  }
  const kdf = parseStrictVaultKdfParams(kdfParams);
  const doc = {
    ic_vault_v: IC_VAULT_JSON_VERSION,
    kdf_salt_b64: bytesToBase64(kdfSalt),
    kdf,
    wrapped_dek_b64: bytesToBase64(wrappedDekBytes),
  };
  return `${JSON.stringify(doc)}\n`;
}

/**
 * @param {string} jsonText
 */
export function decodeVaultJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("vault.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("vault.json must be an object");
  }
  for (const key of Object.keys(parsed)) {
    if (!VAULT_JSON_FIELD_NAMES.has(key)) {
      throw new Error(`vault.json contains forbidden field: ${key}`);
    }
  }
  if (parsed.ic_vault_v !== IC_VAULT_JSON_VERSION) {
    throw new Error("Unsupported vault.json version");
  }
  if (typeof parsed.kdf_salt_b64 !== "string") {
    throw new Error("vault.json missing kdf_salt_b64");
  }
  const kdfSalt = base64ToBytes(parsed.kdf_salt_b64);
  if (kdfSalt.length !== VAULT_KDF_PARAMS.saltLength) {
    throw new Error("vault.json kdf salt must decode to 16 bytes");
  }
  const kdf = parseStrictVaultKdfParams(parsed.kdf);
  if (typeof parsed.wrapped_dek_b64 !== "string") {
    throw new Error("vault.json missing wrapped_dek_b64");
  }
  const wrappedDekBytes = base64ToBytes(parsed.wrapped_dek_b64);
  parseStrictWrappedDekBytes(wrappedDekBytes);
  return {
    version: parsed.ic_vault_v,
    kdfSalt,
    kdf,
    wrappedDekBytes,
  };
}

/**
 * @param {Uint8Array} dek
 * @param {Uint8Array} kek
 * @param {Uint8Array} kdfSalt
 */
export function buildVaultJsonWithWrappedDek(dek, kek, kdfSalt) {
  return encodeVaultJson(wrapDek(dek, kek), kdfSalt);
}

export { DecryptionFailedError, parseWrappedDekRecord, serializeKdfParams, wrapDek };
