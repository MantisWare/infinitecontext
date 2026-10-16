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
export const STORAGE_CAS_CACHE_LAST_GOOD_SUFFIX = ".last-good";
export const STORAGE_CAS_CACHE_CORRUPTION_MARKER_SUFFIX = ".corruption-marker";

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
 * @param {string} cachePath
 */
export function storageCasCacheLastGoodPath(cachePath) {
  return `${cachePath}${STORAGE_CAS_CACHE_LAST_GOOD_SUFFIX}`;
}

/**
 * @param {string} cachePath
 */
export function storageCasCacheCorruptionMarkerPath(cachePath) {
  return `${cachePath}${STORAGE_CAS_CACHE_CORRUPTION_MARKER_SUFFIX}`;
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
 *   doctorSequentialRecheckAtMs?: number,
 *   doctorRaceRecheckAtMs?: number,
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
 * @typedef {{ pid: number, createdAtMs: number, ownerToken: string }} StorageCasCacheLockMeta
 */

/**
 * @param {number} ms
 */
export function sleepMsForCasCacheLockBackoff(ms) {
  const delay = Math.max(0, Math.min(ms, 500));
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, delay);
}

/**
 * @param {number} attempt
 */
function lockBackoffMs(attempt) {
  return Math.min(50 * 2 ** attempt, 250);
}

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
export function loadSalvagedEndpointsFromLastGood(cachePath) {
  const lastGood = storageCasCacheLastGoodPath(cachePath);
  try {
    const parsed = JSON.parse(fs.readFileSync(lastGood, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.endpoints && typeof parsed.endpoints === "object") {
      return /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints);
    }
  } catch {
    /* no last-good snapshot */
  }
  return null;
}

/** @deprecated use loadSalvagedEndpointsFromLastGood */
export function salvagedEndpointsFromCorruptBackups(cachePath) {
  return loadSalvagedEndpointsFromLastGood(cachePath);
}

/**
 * @param {string} cachePath
 * @returns {{ corruptGeneration: string, atMs: number } | null}
 */
export function readStorageCasCorruptionMarker(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storageCasCacheCorruptionMarkerPath(cachePath), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.corruptGeneration === "string") {
      return {
        corruptGeneration: parsed.corruptGeneration,
        atMs: Number(/** @type {{ atMs?: number }} */ (parsed).atMs) || 0,
      };
    }
  } catch {
    /* none */
  }
  return null;
}

/**
 * @param {string} cachePath
 * @param {string} corruptGeneration
 * @param {number} [atMs]
 */
export function writeStorageCasCorruptionMarker(cachePath, corruptGeneration, atMs = Date.now()) {
  const markerPath = storageCasCacheCorruptionMarkerPath(cachePath);
  const dir = path.dirname(markerPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${markerPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const body = `${JSON.stringify({ corruptGeneration, atMs }, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, markerPath);
}

/**
 * @param {string} cachePath
 */
export function clearStorageCasCorruptionMarker(cachePath) {
  try {
    fs.unlinkSync(storageCasCacheCorruptionMarkerPath(cachePath));
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} cachePath
 * @returns {string}
 */
function ensureCorruptionGenerationOnCorruptLoad(cachePath) {
  const existing = readStorageCasCorruptionMarker(cachePath);
  if (existing?.corruptGeneration) {
    return existing.corruptGeneration;
  }
  const generation = crypto.randomBytes(8).toString("hex");
  writeStorageCasCorruptionMarker(cachePath, generation);
  return generation;
}

/**
 * @param {string} cachePath
 * @param {string} body
 */
function persistLastGoodSnapshot(cachePath, body) {
  const lastGood = storageCasCacheLastGoodPath(cachePath);
  const dir = path.dirname(lastGood);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${lastGood}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    assertRealpathUnderRoot(dir, dir);
    fs.writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
    assertRealpathUnderRoot(tmp, dir);
    fs.renameSync(tmp, lastGood);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
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
      const corruptGeneration = ensureCorruptionGenerationOnCorruptLoad(cachePath);
      return {
        v: STORAGE_CAS_CACHE_VERSION,
        endpoints: {},
        corruptGeneration,
        fileCorrupt: true,
        salvagedEndpoints: loadSalvagedEndpointsFromLastGood(cachePath) ?? undefined,
      };
    }
    const endpoints =
      parsed.endpoints && typeof parsed.endpoints === "object" && !Array.isArray(parsed.endpoints)
        ? /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints)
        : {};
    const corruptGeneration =
      typeof parsed.corruptGeneration === "string"
        ? parsed.corruptGeneration
        : readStorageCasCorruptionMarker(cachePath)?.corruptGeneration;
    return { v: STORAGE_CAS_CACHE_VERSION, endpoints, corruptGeneration, fileCorrupt: false };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {}, fileCorrupt: false };
    }
    backupCorruptCacheFile(cachePath);
    const corruptGeneration = ensureCorruptionGenerationOnCorruptLoad(cachePath);
    return {
      v: STORAGE_CAS_CACHE_VERSION,
      endpoints: {},
      corruptGeneration,
      fileCorrupt: true,
      salvagedEndpoints: loadSalvagedEndpointsFromLastGood(cachePath) ?? undefined,
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
    persistLastGoodSnapshot(cachePath, body);
    if (!cache.corruptGeneration) {
      clearStorageCasCorruptionMarker(cachePath);
    }
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
 * @returns {StorageCasCacheLockMeta | null}
 */
function readLockMetadata(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const ownerToken = String(/** @type {{ ownerToken?: string }} */ (parsed).ownerToken ?? "");
      const pid = Number(/** @type {{ pid?: number }} */ (parsed).pid);
      const createdAtMs = Number(/** @type {{ createdAtMs?: number }} */ (parsed).createdAtMs);
      if (!ownerToken || !Number.isFinite(createdAtMs)) {
        return null;
      }
      return { pid, createdAtMs, ownerToken };
    }
  } catch {
    /* unreadable lock — treat as held */
  }
  return null;
}

/**
 * @param {string} lockPath
 * @param {StorageCasCacheLockMeta} expected
 */
function lockMetadataStillMatches(lockPath, expected) {
  const current = readLockMetadata(lockPath);
  return Boolean(
    current &&
      current.ownerToken === expected.ownerToken &&
      current.pid === expected.pid &&
      current.createdAtMs === expected.createdAtMs,
  );
}

/**
 * @param {string} lockPath
 */
function breakStaleCacheLockIfNeeded(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  const meta = readLockMetadata(lockPath);
  if (!meta) {
    return;
  }
  const ageMs = Date.now() - meta.createdAtMs;
  if (isProcessAlive(meta.pid) && ageMs <= STORAGE_CAS_LOCK_MAX_AGE_MS) {
    return;
  }
  if (!lockMetadataStillMatches(lockPath, meta)) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} lockPath
 * @returns {string | null}
 */
function tryAcquireCacheLock(lockPath) {
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAtMs: Date.now(),
    ownerToken,
  })}\n`;
  const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.locktmp`;
  try {
    fs.writeFileSync(tmp, payload, { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(tmp, lockPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        return null;
      }
      throw error;
    }
    fs.unlinkSync(tmp);
    return ownerToken;
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} lockPath
 * @param {number} deadlineMs
 */
function acquireCacheLockWithBackoff(lockPath, deadlineMs) {
  let attempt = 0;
  while (Date.now() < deadlineMs) {
    const token = tryAcquireCacheLock(lockPath);
    if (token) {
      return token;
    }
    breakStaleCacheLockIfNeeded(lockPath);
    sleepMsForCasCacheLockBackoff(lockBackoffMs(attempt));
    attempt += 1;
  }
  return null;
}

/**
 * @param {string} lockPath
 * @param {string | null | undefined} ownerToken
 */
function releaseCacheLock(lockPath, ownerToken) {
  if (!ownerToken) return;
  const meta = readLockMetadata(lockPath);
  if (!meta || meta.ownerToken !== ownerToken) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * @param {StorageCasCacheRecord | undefined} prev
 */
function doctorSequentialPassValidAfterUnsafe(prev) {
  if (!prev?.casUnsafe) return true;
  const unsafeAt = prev.unsafeAtMs ?? 0;
  return Boolean(prev.doctorSequentialRecheckOk && (prev.doctorSequentialRecheckAtMs ?? 0) >= unsafeAt);
}

/**
 * @param {StorageCasCacheRecord | undefined} prev
 */
function doctorRacePassValidAfterUnsafe(prev) {
  if (!prev?.casUnsafe) return true;
  const unsafeAt = prev.unsafeAtMs ?? 0;
  return Boolean(prev.doctorRaceRecheckOk && (prev.doctorRaceRecheckAtMs ?? 0) >= unsafeAt);
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
  const ownerToken = acquireCacheLockWithBackoff(lockPath, deadline);
  if (!ownerToken) {
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
    releaseCacheLock(lockPath, ownerToken);
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
  if (!record) {
    if (cache.corruptGeneration) {
      return {
        bindingKey,
        crossDeviceCas: false,
        probedAtMs: 0,
        expiresAtMs: 0,
        stale: false,
        unsafe: true,
        casUnsafe: true,
        unknownAfterCorruption: true,
      };
    }
    return null;
  }
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
      doctorSequentialRecheckAtMs: undefined,
      doctorRaceRecheckAtMs: undefined,
      failClosedCorruptGen: undefined,
      ...(prev && prev.casUnsafe && prev.unsafeAtMs ? { unsafeAtMs: nowMs } : {}),
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
  const doctorSequentialRecheckAtMs = nowMs;
  const doctorSequentialRecheckOk = true;
  if (raceUnsafe) {
    const unsafeAt = prev?.unsafeAtMs ?? 0;
    const raceOk = doctorRacePassValidAfterUnsafe(prev);
    if (raceOk && doctorSequentialRecheckAtMs >= unsafeAt) {
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
        doctorSequentialRecheckAtMs: undefined,
        doctorRaceRecheckAtMs: undefined,
      };
    }
    return {
      ...prev,
      bindingKey: prev.bindingKey,
      crossDeviceCas: false,
      casUnsafe: true,
      doctorSequentialRecheckOk,
      doctorSequentialRecheckAtMs,
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
    doctorSequentialRecheckAtMs: undefined,
    doctorRaceRecheckAtMs: undefined,
  };
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey, nowMs = Date.now()) {
  const loaded = loadStorageCasCache(cachePath ?? undefined);
  const salvaged = loaded.salvagedEndpoints ?? loadSalvagedEndpointsFromLastGood(cachePath ?? "") ?? {};
  const corruptGeneration =
    loaded.fileCorrupt || Object.keys(salvaged).length
      ? (loaded.corruptGeneration ?? ensureCorruptionGenerationOnCorruptLoad(cachePath ?? storageCasCacheFilePath()))
      : loaded.corruptGeneration;
  mutateStorageCasCache(
    cachePath,
    (cache) => {
      if (!cache.corruptGeneration && (loaded.fileCorrupt || Object.keys(salvaged).length)) {
        cache.corruptGeneration = corruptGeneration ?? crypto.randomBytes(8).toString("hex");
        writeStorageCasCorruptionMarker(cachePath ?? storageCasCacheFilePath(), cache.corruptGeneration);
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
        const doctorRaceRecheckAtMs = nowMs;
        const seqOk = doctorSequentialPassValidAfterUnsafe({
          ...prev,
          doctorSequentialRecheckOk: prev.doctorSequentialRecheckOk,
          doctorSequentialRecheckAtMs: prev.doctorSequentialRecheckAtMs,
        });
        if (seqOk) {
          setStorageCasCacheRecord(cache, bindingKey, {
            bindingKey,
            crossDeviceCas: true,
            probedAtMs: nowMs,
            expiresAtMs,
            casUnsafe: false,
            unsafeReason: undefined,
            unsafeAtMs: undefined,
            failClosedCorruptGen: undefined,
            doctorSequentialRecheckOk: false,
            doctorRaceRecheckOk: false,
            doctorSequentialRecheckAtMs: undefined,
            doctorRaceRecheckAtMs: undefined,
          });
          return;
        }
        setStorageCasCacheRecord(cache, bindingKey, {
          ...prev,
          bindingKey,
          crossDeviceCas: false,
          casUnsafe: true,
          doctorRaceRecheckOk,
          doctorRaceRecheckAtMs,
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
