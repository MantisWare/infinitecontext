import fs from "node:fs";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";

export const STORAGE_CAS_CACHE_VERSION = 1;
export const DEFAULT_STORAGE_CAS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_CAS_CACHE_FILENAME = "storage-cas-probe-cache.json";

/**
 * @param {{ endpoint?: string, bucket: string, prefix?: string }} params
 */
export function storageCasProbeBindingKey(params) {
  const endpoint = String(params.endpoint ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  const bucket = String(params.bucket).trim();
  const prefix = String(params.prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return `s3:${endpoint || "aws"}:${bucket}:${prefix}`;
}

/**
 * @param {string} [homeDir]
 */
export function storageCasCacheFilePath(homeDir = infinitecontextHome()) {
  return path.join(homeDir, STORAGE_CAS_CACHE_FILENAME);
}

/**
 * @typedef {{
 *   crossDeviceCas: boolean,
 *   probedAtMs: number,
 *   expiresAtMs: number,
 *   casUnsafe?: boolean,
 *   unsafeReason?: string,
 *   unsafeAtMs?: number,
 * }} StorageCasCacheRecord
 */

/**
 * @typedef {{ v: number, endpoints: Record<string, StorageCasCacheRecord> }} StorageCasCacheFile
 */

/**
 * @param {string} [cachePath]
 */
export function loadStorageCasCache(cachePath = storageCasCacheFilePath()) {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {} };
    }
    const endpoints =
      parsed.endpoints && typeof parsed.endpoints === "object" && !Array.isArray(parsed.endpoints)
        ? /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints)
        : {};
    return { v: STORAGE_CAS_CACHE_VERSION, endpoints };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {} };
    }
    return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {} };
  }
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} [cachePath]
 */
export function saveStorageCasCache(cache, cachePath = storageCasCacheFilePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, cachePath);
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function getStorageCasCacheRecord(cache, bindingKey, nowMs = Date.now()) {
  const record = cache.endpoints[bindingKey];
  if (!record) return null;
  if (record.casUnsafe) {
    return { ...record, stale: false, unsafe: true, crossDeviceCas: false };
  }
  const fresh = Number(record.expiresAtMs) > nowMs;
  return { ...record, stale: !fresh, unsafe: false };
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 * @param {StorageCasCacheRecord} record
 */
export function setStorageCasCacheRecord(cache, bindingKey, record) {
  cache.endpoints[bindingKey] = record;
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 * @param {string} [reason]
 * @param {number} [nowMs]
 */
export function markStorageCasUnsafe(cache, bindingKey, reason = "probe_failed", nowMs = Date.now()) {
  const prev = cache.endpoints[bindingKey] ?? {
    crossDeviceCas: false,
    probedAtMs: nowMs,
    expiresAtMs: 0,
  };
  setStorageCasCacheRecord(cache, bindingKey, {
    ...prev,
    crossDeviceCas: false,
    casUnsafe: true,
    unsafeReason: reason,
    unsafeAtMs: nowMs,
    probedAtMs: nowMs,
    expiresAtMs: 0,
  });
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 * @param {boolean} crossDeviceCas
 * @param {number} [nowMs]
 * @param {number} [ttlMs]
 */
export function recordStorageCasProbeSuccess(
  cache,
  bindingKey,
  crossDeviceCas,
  nowMs = Date.now(),
  ttlMs = DEFAULT_STORAGE_CAS_CACHE_TTL_MS,
) {
  setStorageCasCacheRecord(cache, bindingKey, {
    crossDeviceCas,
    probedAtMs: nowMs,
    expiresAtMs: crossDeviceCas ? nowMs + ttlMs : 0,
    casUnsafe: false,
    unsafeReason: undefined,
    unsafeAtMs: undefined,
  });
}
