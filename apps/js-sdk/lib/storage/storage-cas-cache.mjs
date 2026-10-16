import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { normalizeStorageCasEndpoint } from "./storage-cas-endpoint.mjs";

export const STORAGE_CAS_CACHE_VERSION = 1;
export const DEFAULT_STORAGE_CAS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_CAS_CACHE_FILENAME = "storage-cas-probe-cache.json";

/**
 * @param {{ endpoint?: string, bucket: string, prefix?: string }} params
 */
export function storageCasProbeBindingKey(params) {
  const endpoint = normalizeStorageCasEndpoint(params.endpoint);
  const bucket = String(params.bucket).trim();
  const prefix = String(params.prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return `s3:${endpoint}:${bucket}:${prefix}`;
}

/**
 * @param {string} [homeDir]
 */
export function storageCasCacheFilePath(homeDir = infinitecontextHome()) {
  return path.join(homeDir, STORAGE_CAS_CACHE_FILENAME);
}

/**
 * @typedef {{
 *   bindingKey: string,
 *   crossDeviceCas: boolean,
 *   probedAtMs: number,
 *   expiresAtMs: number,
 *   casUnsafe?: boolean,
 *   unsafeReason?: string,
 *   unsafeAtMs?: number,
 * }} StorageCasCacheRecord
 */

/**
 * @typedef {{ v: number, endpoints: Record<string, StorageCasCacheRecord>, fileCorrupt?: boolean }} StorageCasCacheFile
 */

/**
 * @param {string} cachePath
 */
function backupCorruptCacheFile(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(cachePath, `${cachePath}.corrupt.${stamp}.bak`);
  } catch {
    /* best-effort */
  }
}

/**
 * @param {string} [cachePath]
 */
export function loadStorageCasCache(cachePath = storageCasCacheFilePath()) {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptCacheFile(cachePath);
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {}, fileCorrupt: true };
    }
    const endpoints =
      parsed.endpoints && typeof parsed.endpoints === "object" && !Array.isArray(parsed.endpoints)
        ? /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints)
        : {};
    return { v: STORAGE_CAS_CACHE_VERSION, endpoints, fileCorrupt: false };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {}, fileCorrupt: false };
    }
    backupCorruptCacheFile(cachePath);
    return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {}, fileCorrupt: true };
  }
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} cachePath
 */
export function saveStorageCasCache(cache, cachePath = storageCasCacheFilePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const tmp = `${cachePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: cache.v, endpoints: cache.endpoints }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, cachePath);
}

/**
 * @param {StorageCasCacheRecord | undefined} prev
 * @param {StorageCasCacheRecord} next
 * @param {{ allowClearUnsafe?: boolean }} [mergeOptions]
 */
export function mergeStorageCasCacheRecords(prev, next, mergeOptions = {}) {
  if (!prev) {
    return next;
  }
  if (prev.casUnsafe && !mergeOptions.allowClearUnsafe) {
    return {
      ...prev,
      bindingKey: next.bindingKey,
      probedAtMs: Math.max(prev.probedAtMs ?? 0, next.probedAtMs ?? 0),
    };
  }
  return next;
}

/**
 * @param {string} cachePath
 * @param {(cache: StorageCasCacheFile) => void} mutator
 * @param {{ allowClearUnsafe?: boolean }} [options]
 */
export function mutateStorageCasCache(cachePath, mutator, options = {}) {
  const resolvedPath = cachePath ?? storageCasCacheFilePath();
  const lockPath = `${resolvedPath}.lock`;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  /** @type {number | undefined} */
  let lockFd;
  while (Date.now() < deadline) {
    try {
      lockFd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      break;
    } catch {
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* spin briefly */
      }
    }
  }
  if (lockFd === undefined) {
    throw new Error("Timed out waiting for storage CAS cache lock");
  }
  try {
    const cache = loadStorageCasCache(resolvedPath);
    /** @type {Record<string, StorageCasCacheRecord>} */
    const prevSnapshot = { ...cache.endpoints };
    mutator(cache);
    for (const key of Object.keys(cache.endpoints)) {
      cache.endpoints[key] = mergeStorageCasCacheRecords(prevSnapshot[key], cache.endpoints[key], options);
    }
    delete cache.fileCorrupt;
    saveStorageCasCache(cache, resolvedPath);
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function getStorageCasCacheRecord(cache, bindingKey, nowMs = Date.now()) {
  if (cache.fileCorrupt) {
    return {
      bindingKey,
      crossDeviceCas: false,
      probedAtMs: 0,
      expiresAtMs: 0,
      stale: false,
      unsafe: true,
      casUnsafe: true,
      corrupt: true,
    };
  }
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
  cache.endpoints[bindingKey] = { ...record, bindingKey };
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {string} [reason]
 * @param {number} [nowMs]
 */
export function markStorageCasUnsafePersisted(
  cachePath,
  bindingKey,
  reason = "probe_failed",
  nowMs = Date.now(),
) {
  mutateStorageCasCache(cachePath, (cache) => {
    const prev = cache.endpoints[bindingKey];
    setStorageCasCacheRecord(cache, bindingKey, {
      bindingKey,
      crossDeviceCas: false,
      casUnsafe: true,
      unsafeReason: reason,
      unsafeAtMs: nowMs,
      probedAtMs: nowMs,
      expiresAtMs: 0,
      ...(prev && prev.casUnsafe ? { unsafeAtMs: prev.unsafeAtMs ?? nowMs } : {}),
    });
  });
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {boolean} crossDeviceCas
 * @param {number} [nowMs]
 * @param {number} [ttlMs]
 */
export function recordStorageCasProbeSuccessPersisted(
  cachePath,
  bindingKey,
  crossDeviceCas,
  nowMs = Date.now(),
  ttlMs = DEFAULT_STORAGE_CAS_CACHE_TTL_MS,
) {
  const expiresAtMs = crossDeviceCas ? Math.min(nowMs + ttlMs, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS) : 0;
  mutateStorageCasCache(
    cachePath,
    (cache) => {
      setStorageCasCacheRecord(cache, bindingKey, {
        bindingKey,
        crossDeviceCas,
        probedAtMs: nowMs,
        expiresAtMs,
        casUnsafe: false,
        unsafeReason: undefined,
        unsafeAtMs: undefined,
      });
    },
    { allowClearUnsafe: true },
  );
}

/** @deprecated use markStorageCasUnsafePersisted inside locked mutators */
export function markStorageCasUnsafe(cache, bindingKey, reason = "probe_failed", nowMs = Date.now()) {
  const prev = cache.endpoints[bindingKey];
  setStorageCasCacheRecord(cache, bindingKey, {
    bindingKey,
    crossDeviceCas: false,
    casUnsafe: true,
    unsafeReason: reason,
    unsafeAtMs: nowMs,
    probedAtMs: nowMs,
    expiresAtMs: 0,
    ...prev,
  });
}

/** @deprecated use recordStorageCasProbeSuccessPersisted */
export function recordStorageCasProbeSuccess(
  cache,
  bindingKey,
  crossDeviceCas,
  nowMs = Date.now(),
  ttlMs = DEFAULT_STORAGE_CAS_CACHE_TTL_MS,
) {
  setStorageCasCacheRecord(cache, bindingKey, {
    bindingKey,
    crossDeviceCas,
    probedAtMs: nowMs,
    expiresAtMs: crossDeviceCas ? Math.min(nowMs + ttlMs, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS) : 0,
    casUnsafe: false,
    unsafeReason: undefined,
    unsafeAtMs: undefined,
  });
}

/** @deprecated use mutateStorageCasCache */
export function saveStorageCasCacheLegacy(cache, cachePath = storageCasCacheFilePath()) {
  saveStorageCasCache(cache, cachePath);
}
