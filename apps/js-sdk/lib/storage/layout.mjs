import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import {
  AEAD_ALG,
  DecryptionFailedError,
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
export const NAMING_KEY_INFO = "ic-storage-names-v1";
export const SEGMENT_BUCKET_BYTES = 4096;
export const DEVH_BYTES = 16;

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** @typedef {import("../ic-crypto.mjs").AeadEnvelope} AeadEnvelope */

/**
 * @typedef {Object} LayoutLogSegmentRecord
 * @property {string} dev device UUID
 * @property {number} seq
 * @property {string} prev_digest hex sha256 of previous segment envelope JSON (empty at seq 0)
 * @property {string} created_at ISO-8601
 * @property {unknown[]} mutations
 */

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
  return `${layoutRootPath(prefix)}/devices/${devH}.json.enc`;
}

/** @param {string} prefix @param {string} devH @param {number} seq */
export function logSegmentRelativePath(prefix, devH, seq) {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("Log segment seq must be a non-negative integer");
  }
  return `${layoutRootPath(prefix)}/log/${devH}/${String(seq).padStart(12, "0")}.enc`;
}

/** @param {string} prefix @param {number} epoch */
export function snapEncRelativePath(prefix, epoch) {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error("Snapshot epoch must be a non-negative integer");
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
  const namingKey = deriveNamingKey(dek);
  const mac = hmac(sha256, namingKey, new TextEncoder().encode(String(deviceUuid)));
  return encodeCrockfordBase32(mac.slice(0, DEVH_BYTES));
}

/**
 * @param {string} devH
 * @param {number} seq
 */
export function buildLayoutLogSegmentAad(devH, seq) {
  if (!/^[0-9A-Z]+$/.test(devH)) {
    throw new Error("devH must be Crockford base32");
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("seq must be a non-negative integer");
  }
  return new TextEncoder().encode(`ic-storage|log|${devH}|${seq}`);
}

/**
 * @param {Uint8Array} paddedPlaintext
 */
export function unpadSegmentPlaintext(paddedPlaintext) {
  let end = paddedPlaintext.length;
  while (end > 0 && paddedPlaintext[end - 1] === 0) {
    end -= 1;
  }
  const slice = paddedPlaintext.slice(0, end);
  return new TextDecoder().decode(slice);
}

/**
 * @param {string} jsonText
 */
export function padSegmentPlaintext(jsonText) {
  const body = new TextEncoder().encode(jsonText);
  if (body.length > SEGMENT_BUCKET_BYTES) {
    throw new Error(`Segment plaintext exceeds ${SEGMENT_BUCKET_BYTES}-byte bucket`);
  }
  const padded = new Uint8Array(SEGMENT_BUCKET_BYTES);
  padded.set(body, 0);
  return padded;
}

/**
 * @param {LayoutLogSegmentRecord} record
 */
export function serializeLogSegmentRecord(record) {
  return JSON.stringify({
    dev: record.dev,
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
  if (typeof parsed.dev !== "string" || typeof parsed.prev_digest !== "string") {
    throw new Error("Log segment record missing dev or prev_digest");
  }
  if (!Number.isInteger(parsed.seq) || parsed.seq < 0) {
    throw new Error("Log segment record seq invalid");
  }
  if (typeof parsed.created_at !== "string" || !Array.isArray(parsed.mutations)) {
    throw new Error("Log segment record missing created_at or mutations");
  }
  return /** @type {LayoutLogSegmentRecord} */ (parsed);
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
function encryptAeadWithNonce(key, plaintext, aad, nonce) {
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
 * @param {{ nonce?: Uint8Array }} [options]
 */
export function encryptLogSegment(dek, devH, record, options = {}) {
  if (record.seq !== 0 && !record.prev_digest) {
    throw new Error("Non-genesis log segments require prev_digest");
  }
  const aad = buildLayoutLogSegmentAad(devH, record.seq);
  const padded = padSegmentPlaintext(serializeLogSegmentRecord(record));
  if (options.nonce) {
    return encryptAeadWithNonce(dek, padded, aad, options.nonce);
  }
  return encryptAead(dek, padded, aad);
}

/**
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {number} seq
 * @param {AeadEnvelope} envelope
 */
export function decryptLogSegment(dek, devH, seq, envelope) {
  const aad = buildLayoutLogSegmentAad(devH, seq);
  const padded = decryptAead(dek, envelope, aad);
  if (padded.length !== SEGMENT_BUCKET_BYTES) {
    throw new Error("Decrypted segment has invalid padded length");
  }
  return parseLogSegmentRecord(unpadSegmentPlaintext(padded));
}

/**
 * @param {Uint8Array} dek
 * @param {string} devH
 * @param {{ seq: number, envelope: AeadEnvelope }[]} orderedSegments ascending by seq
 */
export function verifyLogSegmentChain(dek, devH, orderedSegments) {
  /** @type {string | null} */
  let expectedPrev = null;
  for (const row of orderedSegments) {
    const record = decryptLogSegment(dek, devH, row.seq, row.envelope);
    if (record.seq !== row.seq) {
      throw new Error(`Segment seq mismatch (path ${row.seq}, payload ${record.seq})`);
    }
    if (expectedPrev === null) {
      if (record.seq !== 0 || record.prev_digest !== "") {
        throw new Error("Genesis segment must have seq 0 and empty prev_digest");
      }
    } else if (record.prev_digest !== expectedPrev) {
      throw new Error("Log segment prev_digest mismatch (reorder or tamper)");
    }
    expectedPrev = layoutSegmentEnvelopeDigest(row.envelope);
  }
  return true;
}

/**
 * @param {Uint8Array} wrappedDekBytes from wrapDek()
 * @param {Record<string, unknown>} [kdfParams]
 */
export function encodeVaultJson(wrappedDekBytes, kdfParams = serializeKdfParams()) {
  parseWrappedDekRecord(wrappedDekBytes);
  const doc = {
    ic_vault_v: IC_VAULT_JSON_VERSION,
    kdf: kdfParams,
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
  const allowed = new Set(["ic_vault_v", "kdf", "wrapped_dek_b64"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw new Error(`vault.json contains forbidden field: ${key}`);
    }
  }
  if (parsed.ic_vault_v !== IC_VAULT_JSON_VERSION) {
    throw new Error("Unsupported vault.json version");
  }
  if (!parsed.kdf || typeof parsed.kdf !== "object") {
    throw new Error("vault.json missing kdf params");
  }
  if (typeof parsed.wrapped_dek_b64 !== "string") {
    throw new Error("vault.json missing wrapped_dek_b64");
  }
  const wrappedDekBytes = base64ToBytes(parsed.wrapped_dek_b64);
  parseWrappedDekRecord(wrappedDekBytes);
  return {
    version: parsed.ic_vault_v,
    kdf: parsed.kdf,
    wrappedDekBytes,
  };
}

/**
 * @param {Uint8Array} dek
 * @param {Uint8Array} kek
 */
export function buildVaultJsonWithWrappedDek(dek, kek) {
  return encodeVaultJson(wrapDek(dek, kek));
}

export { DecryptionFailedError, parseWrappedDekRecord, serializeKdfParams, wrapDek };
