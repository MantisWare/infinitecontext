import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { assertRealpathUnderRoot } from "./filesystem-object-file.mjs";
import { normalizeStorageCasEndpoint } from "./storage-cas-endpoint.mjs";

export const STORAGE_CAS_CACHE_VERSION = 1;
export const DEFAULT_STORAGE_CAS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_CAS_CACHE_FILENAME = "storage-cas-probe-cache.json";
export const STORAGE_CAS_LOCK_MAX_AGE_MS = 60_000;

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
 * @param {string | undefined} reason
 */
export function isRaceRelatedCasUnsafeReason(reason) {
  const r = String(reason ?? "");
  return r.startsWith("race_");
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
 *   failClosedCorruptGen?: string,
 *   doctorSequentialRecheckOk?: boolean,
 *   doctorRaceRecheckOk?: boolean,
 * }} StorageCasCacheRecord
 */

/**
 * @typedef {{
 *   v: number,
 *   corruptGeneration?: string,
 *   endpoints: Record<string, StorageCasCacheRecord>,
 *   fileCorrupt?: boolean,
 *   salvagedEndpoints?: Record<string, StorageCasCacheRecord>,
 * }} StorageCasCacheFile
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
 * @param {string} cachePath
 * @returns {Record<string, StorageCasCacheRecord> | null}
 */
export function salvagedEndpointsFromCorruptBackups(cachePath) {
  const dir = path.dirname(cachePath);
  const base = path.basename(cachePath);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => n.startsWith(`${base}.corrupt.`) && n.endsWith(".bak"))
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (parsed && typeof parsed === "object" && parsed.endpoints && typeof parsed.endpoints === "object") {
        return /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints);
      }
    } catch {
      /* try next backup */
    }
  }
  return null;
}

/**
 * @param {StorageCasCacheRecord} record
 * @param {string} bindingKey
 * @param {number} nowMs
 */
export function normalizeStorageCasCacheRecordOnRead(record, bindingKey, nowMs = Date.now()) {
  if (record.bindingKey !== bindingKey) {
    return {
      ...record,
      bindingKey,
      crossDeviceCas: false,
      casUnsafe: true,
      unsafeReason: "binding_key_mismatch",
      untrusted: true,
      stale: true,
      unsafe: true,
    };
  }
  const maxExpires = Number(record.probedAtMs) + DEFAULT_STORAGE_CAS_CACHE_TTL_MS;
  let expiresAtMs = Number(record.expiresAtMs);
  if (expiresAtMs > maxExpires) {
    expiresAtMs = maxExpires;
  }
  const stale = expiresAtMs <= nowMs;
  const unsafe = Boolean(record.casUnsafe || record.failClosedCorruptGen);
  return {
    ...record,
    expiresAtMs,
    stale,
    unsafe,
    untrusted: expiresAtMs !== Number(record.expiresAtMs),
  };
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
      return {
        v: STORAGE_CAS_CACHE_VERSION,
        endpoints: {},
        fileCorrupt: true,
        salvagedEndpoints: salvagedEndpointsFromCorruptBackups(cachePath) ?? undefined,
      };
    }
    const endpoints =
      parsed.endpoints && typeof parsed.endpoints === "object" && !Array.isArray(parsed.endpoints)
        ? /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints)
        : {};
    const corruptGeneration =
      typeof parsed.corruptGeneration === "string" ? parsed.corruptGeneration : undefined;
    return { v: STORAGE_CAS_CACHE_VERSION, endpoints, corruptGeneration, fileCorrupt: false };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {}, fileCorrupt: false };
    }
    backupCorruptCacheFile(cachePath);
    return {
      v: STORAGE_CAS_CACHE_VERSION,
      endpoints: {},
      fileCorrupt: true,
      salvagedEndpoints: salvagedEndpointsFromCorruptBackups(cachePath) ?? undefined,
    };
  }
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} cachePath
 */
export function saveStorageCasCache(cache, cachePath = storageCasCacheFilePath()) {
  const cacheDir = path.dirname(cachePath);
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const tmp = `${cachePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const payload = {
    v: cache.v,
    ...(cache.corruptGeneration ? { corruptGeneration: cache.corruptGeneration } : {}),
    endpoints: cache.endpoints,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  /** @param {string} tempPath */
  const removeTempIfPresent = (tempPath) => {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  };
  let fd;
  try {
    assertRealpathUnderRoot(cacheDir, cacheDir);
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, body, 0, Buffer.byteLength(body), 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertRealpathUnderRoot(tmp, cacheDir);
    fs.renameSync(tmp, cachePath);
  } catch (error) {
    removeTempIfPresent(tmp);
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {number} pid
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} lockPath
 */
function readLockMetadata(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        pid: Number(/** @type {{ pid?: number }} */ (parsed).pid),
        createdAtMs: Number(/** @type {{ createdAtMs?: number }} */ (parsed).createdAtMs),
      };
    }
  } catch {
    /* legacy empty lock */
  }
  return { pid: NaN, createdAtMs: 0 };
}

/**
 * @param {string} lockPath
 */
function breakStaleCacheLockIfNeeded(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  const meta = readLockMetadata(lockPath);
  const ageMs = meta.createdAtMs ? Date.now() - meta.createdAtMs : STORAGE_CAS_LOCK_MAX_AGE_MS + 1;
  if (!isProcessAlive(meta.pid) || ageMs > STORAGE_CAS_LOCK_MAX_AGE_MS) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} lockPath
 */
function acquireCacheLock(lockPath) {
  breakStaleCacheLockIfNeeded(lockPath);
  const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  fs.writeFileSync(
    fd,
    `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`,
    { encoding: "utf8" },
  );
  return fd;
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
 * @param {string} corruptGeneration
 * @param {StorageCasCacheRecord} rec
 */
function failClosedCorruptRecord(corruptGeneration, rec) {
  return {
    ...rec,
    bindingKey: rec.bindingKey,
    crossDeviceCas: false,
    casUnsafe: true,
    unsafeReason: rec.unsafeReason ?? "fail_closed_corrupt_cache",
    failClosedCorruptGen: corruptGeneration,
    expiresAtMs: 0,
  };
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 * @param {Record<string, StorageCasCacheRecord>} salvaged
 * @param {string} corruptGeneration
 */
export function preserveFailClosedEndpointsAfterCorrupt(cache, bindingKey, salvaged, corruptGeneration) {
  for (const [key, rec] of Object.entries(salvaged)) {
    if (key === bindingKey) continue;
    setStorageCasCacheRecord(cache, key, failClosedCorruptRecord(corruptGeneration, rec));
  }
  for (const [key, rec] of Object.entries(cache.endpoints)) {
    if (key === bindingKey) continue;
    if (rec.failClosedCorruptGen || rec.casUnsafe) {
      setStorageCasCacheRecord(
        cache,
        key,
        failClosedCorruptRecord(cache.corruptGeneration ?? corruptGeneration, rec),
      );
    }
  }
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
      lockFd = acquireCacheLock(lockPath);
      break;
    } catch {
      breakStaleCacheLockIfNeeded(lockPath);
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
    delete cache.salvagedEndpoints;
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
  const normalized = normalizeStorageCasCacheRecordOnRead(record, bindingKey, nowMs);
  if (normalized.failClosedCorruptGen && cache.corruptGeneration) {
    if (normalized.failClosedCorruptGen === cache.corruptGeneration) {
      return { ...normalized, unsafe: true, casUnsafe: true, stale: false };
    }
  }
  if (normalized.casUnsafe || normalized.unsafe) {
    return { ...normalized, crossDeviceCas: false };
  }
  return normalized;
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
      doctorSequentialRecheckOk: false,
      doctorRaceRecheckOk: false,
      ...(prev && prev.casUnsafe ? { unsafeAtMs: prev.unsafeAtMs ?? nowMs } : {}),
    });
  });
}

/**
 * Init probe success — never clears cas_unsafe (doctor only).
 *
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function recordStorageCasInitProbeSuccess(cachePath, bindingKey, nowMs = Date.now()) {
  const expiresAtMs = Math.min(nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS);
  mutateStorageCasCache(cachePath, (cache) => {
    setStorageCasCacheRecord(cache, bindingKey, {
      bindingKey,
      crossDeviceCas: true,
      probedAtMs: nowMs,
      expiresAtMs,
    });
  });
}

/**
 * @param {StorageCasCacheRecord | undefined} prev
 * @param {number} nowMs
 */
function doctorRecheckSuccessRecord(prev, nowMs) {
  const expiresAtMs = Math.min(nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS);
  const raceUnsafe = prev?.casUnsafe && isRaceRelatedCasUnsafeReason(prev.unsafeReason);
  if (raceUnsafe) {
    const doctorSequentialRecheckOk = true;
    const doctorRaceRecheckOk = Boolean(prev?.doctorRaceRecheckOk);
    if (doctorRaceRecheckOk) {
      return {
        bindingKey: prev.bindingKey,
        crossDeviceCas: true,
        probedAtMs: nowMs,
        expiresAtMs,
        casUnsafe: false,
        unsafeReason: undefined,
        unsafeAtMs: undefined,
        failClosedCorruptGen: undefined,
        doctorSequentialRecheckOk: false,
        doctorRaceRecheckOk: false,
      };
    }
    return {
      ...prev,
      bindingKey: prev.bindingKey,
      crossDeviceCas: false,
      casUnsafe: true,
      doctorSequentialRecheckOk,
      probedAtMs: nowMs,
      expiresAtMs: 0,
    };
  }
  return {
    bindingKey: prev?.bindingKey ?? "",
    crossDeviceCas: true,
    probedAtMs: nowMs,
    expiresAtMs,
    casUnsafe: false,
    unsafeReason: undefined,
    unsafeAtMs: undefined,
    failClosedCorruptGen: undefined,
    doctorSequentialRecheckOk: false,
    doctorRaceRecheckOk: false,
  };
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey, nowMs = Date.now()) {
  const loaded = loadStorageCasCache(cachePath ?? undefined);
  const salvaged = loaded.salvagedEndpoints ?? {};
  const corruptGeneration =
    loaded.fileCorrupt || Object.keys(salvaged).length
      ? (loaded.corruptGeneration ?? crypto.randomBytes(8).toString("hex"))
      : loaded.corruptGeneration;
  mutateStorageCasCache(
    cachePath,
    (cache) => {
      if (!cache.corruptGeneration && (loaded.fileCorrupt || Object.keys(salvaged).length)) {
        cache.corruptGeneration = corruptGeneration ?? crypto.randomBytes(8).toString("hex");
      }
      if (cache.corruptGeneration && (loaded.fileCorrupt || Object.keys(salvaged).length)) {
        preserveFailClosedEndpointsAfterCorrupt(cache, bindingKey, salvaged, cache.corruptGeneration);
      }
      const prev = cache.endpoints[bindingKey] ?? salvaged[bindingKey];
      setStorageCasCacheRecord(cache, bindingKey, {
        ...doctorRecheckSuccessRecord(prev, nowMs),
        bindingKey,
      });
    },
    { allowClearUnsafe: true },
  );
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function recordStorageCasDoctorRaceSuccess(cachePath, bindingKey, nowMs = Date.now()) {
  mutateStorageCasCache(
    cachePath,
    (cache) => {
      const prev = cache.endpoints[bindingKey];
      const expiresAtMs = Math.min(nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS);
      if (prev?.casUnsafe && isRaceRelatedCasUnsafeReason(prev.unsafeReason)) {
        const doctorRaceRecheckOk = true;
        const doctorSequentialRecheckOk = Boolean(prev.doctorSequentialRecheckOk);
        if (doctorSequentialRecheckOk) {
          setStorageCasCacheRecord(cache, bindingKey, {
            bindingKey,
            crossDeviceCas: true,
            probedAtMs: nowMs,
            expiresAtMs,
            casUnsafe: false,
            unsafeReason: undefined,
            unsafeAtMs: undefined,
            failClosedCorruptGen: undefined,
          });
          return;
        }
        setStorageCasCacheRecord(cache, bindingKey, {
          ...prev,
          bindingKey,
          crossDeviceCas: false,
          casUnsafe: true,
          doctorRaceRecheckOk,
        });
        return;
      }
      setStorageCasCacheRecord(cache, bindingKey, {
        bindingKey,
        crossDeviceCas: prev?.crossDeviceCas ?? false,
        probedAtMs: prev?.probedAtMs ?? nowMs,
        expiresAtMs: prev?.expiresAtMs ?? 0,
        casUnsafe: prev?.casUnsafe,
        unsafeReason: prev?.unsafeReason,
      });
    },
    { allowClearUnsafe: true },
  );
}

/** @deprecated */
export function recordStorageCasProbeSuccessPersisted(
  cachePath,
  bindingKey,
  crossDeviceCas,
  nowMs = Date.now(),
) {
  if (crossDeviceCas) {
    recordStorageCasInitProbeSuccess(cachePath, bindingKey, nowMs);
  }
}
