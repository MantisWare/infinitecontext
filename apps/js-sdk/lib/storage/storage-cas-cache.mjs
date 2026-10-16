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
export const STORAGE_CAS_TIME_SKEW_MS = 5_000;
export const STORAGE_CAS_CACHE_LAST_GOOD_SUFFIX = ".last-good";
export const STORAGE_CAS_CACHE_CORRUPTION_MARKER_SUFFIX = ".corruption-marker";

/**
 * @param {string | undefined | null} cachePath
 */
export function resolveStorageCasCachePath(cachePath) {
  const trimmed = cachePath === undefined || cachePath === null ? "" : String(cachePath).trim();
  if (trimmed) {
    return trimmed;
  }
  return storageCasCacheFilePath();
}

/**
 * @param {number} ts
 * @param {number} [nowMs]
 */
export function capCasTimestamp(ts, nowMs = Date.now()) {
  return Math.min(ts, nowMs + STORAGE_CAS_TIME_SKEW_MS);
}

/** @type {() => number} */
let storageCasClockMs = () => Date.now();

/**
 * @param {(() => number) | null | undefined} clock
 */
export function setStorageCasClockForTests(clock) {
  storageCasClockMs = clock ?? (() => Date.now());
}

function casNowMs() {
  return storageCasClockMs();
}

/** @type {string | undefined} */
let lastCasCacheLockBreakHint;

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
 *   seqRecheckAtMs?: number,
 *   racePassAtMs?: number,
 *   flagKind?: string,
 *   doctorSequentialRecheckOk?: boolean,
 *   doctorRaceRecheckOk?: boolean,
 *   doctorSequentialRecheckAtMs?: number,
 *   doctorRaceRecheckAtMs?: number,
 * }} StorageCasCacheRecord
 */

/**
 * @typedef {{
 *   v: number,
 *   endpoints: Record<string, StorageCasCacheRecord>,
 *   fileCorrupt?: boolean,
 *   salvagedEndpoints?: Record<string, StorageCasCacheRecord>,
 *   corruptedAtMs?: number,
 *   salvageMergedForCorruptedAtMs?: number,
 *   salvageUnavailable?: boolean,
 *   positivelyIdentifiedBindings?: Record<string, true>,
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
 * @typedef {{
 *   casUnsafe?: boolean,
 *   flagKind?: string,
 *   unsafeReason?: string,
 *   unsafeAtMs?: number,
 * }} StorageCasSalvagedBindingSnapshot
 */

/**
 * @typedef {{
 *   corruptedAtMs: number,
 *   salvagedBindings?: Record<string, StorageCasSalvagedBindingSnapshot>,
 * }} StorageCasCorruptionMarkerFile
 */

/**
 * @param {Record<string, StorageCasCacheRecord>} endpoints
 */
function snapshotSalvagedBindingsFromEndpoints(endpoints) {
  /** @type {Record<string, StorageCasSalvagedBindingSnapshot>} */
  const out = {};
  for (const [key, rec] of Object.entries(endpoints)) {
    const norm = normalizeRecordTrustFields(rec);
    if (!norm) continue;
    out[key] = {
      ...(norm.casUnsafe ? { casUnsafe: true } : {}),
      ...(norm.flagKind ? { flagKind: norm.flagKind } : {}),
      ...(norm.unsafeReason ? { unsafeReason: norm.unsafeReason } : {}),
      ...(norm.unsafeAtMs ? { unsafeAtMs: norm.unsafeAtMs } : {}),
    };
  }
  return out;
}

/**
 * @param {string} resolvedPath
 */
function snapshotSalvagedBindingsFromLastGoodAtCorruption(resolvedPath) {
  const salvaged = loadSalvagedEndpointsFromLastGood(resolvedPath);
  if (!salvaged) {
    return {};
  }
  return snapshotSalvagedBindingsFromEndpoints(salvaged);
}

/**
 * @param {Record<string, StorageCasSalvagedBindingSnapshot> | undefined} salvagedBindings
 */
function salvagedEndpointRecordsFromMarkerSnapshot(salvagedBindings) {
  /** @type {Record<string, StorageCasCacheRecord>} */
  const out = {};
  for (const [key, snap] of Object.entries(salvagedBindings ?? {})) {
    out[key] = {
      bindingKey: key,
      crossDeviceCas: false,
      casUnsafe: Boolean(snap.casUnsafe),
      unsafeReason: snap.unsafeReason ?? snap.flagKind,
      flagKind: snap.flagKind,
      unsafeAtMs: snap.unsafeAtMs,
      probedAtMs: 0,
      expiresAtMs: 0,
    };
  }
  return out;
}

/**
 * @param {string} resolvedPath
 * @returns {StorageCasCorruptionMarkerFile | null}
 */
function readStorageCasCorruptionMarkerFileRaw(resolvedPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storageCasCacheCorruptionMarkerPath(resolvedPath), "utf8"));
    if (parsed && typeof parsed === "object") {
      const corruptedAtMs = Number(
        /** @type {{ corruptedAtMs?: number, atMs?: number }} */ (parsed).corruptedAtMs ??
          /** @type {{ atMs?: number }} */ (parsed).atMs,
      );
      if (Number.isFinite(corruptedAtMs) && corruptedAtMs > 0) {
        const salvagedBindings =
          /** @type {{ salvagedBindings?: Record<string, StorageCasSalvagedBindingSnapshot> }} */ (parsed)
            .salvagedBindings;
        return {
          corruptedAtMs,
          ...(salvagedBindings && typeof salvagedBindings === "object" ? { salvagedBindings } : {}),
        };
      }
    }
  } catch {
    /* none */
  }
  return null;
}

/**
 * @param {string} cachePath
 * @returns {StorageCasCorruptionMarkerFile | null}
 */
export function readStorageCasCorruptionMarkerFile(cachePath) {
  const resolved = resolveStorageCasCachePath(cachePath);
  const raw = readStorageCasCorruptionMarkerFileRaw(resolved);
  if (!raw) {
    return null;
  }
  return {
    ...raw,
    corruptedAtMs: capCasTimestamp(raw.corruptedAtMs, casNowMs()),
  };
}

/**
 * @param {string} cachePath
 * @returns {{ corruptedAtMs: number } | null}
 */
export function readStorageCasCorruptionMarker(cachePath) {
  const file = readStorageCasCorruptionMarkerFile(cachePath);
  if (!file) {
    return null;
  }
  return { corruptedAtMs: file.corruptedAtMs };
}

/**
 * @param {string} cachePath
 * @param {StorageCasCorruptionMarkerFile} marker
 */
export function writeStorageCasCorruptionMarkerFile(cachePath, marker) {
  const resolved = resolveStorageCasCachePath(cachePath);
  const markerPath = storageCasCacheCorruptionMarkerPath(resolved);
  const dir = path.dirname(markerPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${markerPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, markerPath);
}

/** @deprecated use writeStorageCasCorruptionMarkerFile */
export function writeStorageCasCorruptionMarker(cachePath, corruptedAtMs) {
  writeStorageCasCorruptionMarkerFile(cachePath, { corruptedAtMs: capCasTimestamp(corruptedAtMs, casNowMs()) });
}

/**
 * @param {string} cachePath
 * @param {number} [nowMs]
 * @param {{ salvagedBindings?: Record<string, StorageCasSalvagedBindingSnapshot>, resnapshotSalvaged?: boolean }} [options]
 * @returns {number}
 */
export function bumpStorageCasCorruptionMarker(cachePath, nowMs = casNowMs(), options = {}) {
  const resolved = resolveStorageCasCachePath(cachePath);
  const existing = readStorageCasCorruptionMarkerFileRaw(resolved);
  const wallNow = casNowMs();
  const requestNow = capCasTimestamp(nowMs, wallNow);
  const corruptedAtMs = Math.max(existing?.corruptedAtMs ?? 0, requestNow);
  let salvagedBindings = existing?.salvagedBindings;
  if (options.salvagedBindings) {
    salvagedBindings = options.salvagedBindings;
  } else if (!existing || options.resnapshotSalvaged) {
    salvagedBindings = snapshotSalvagedBindingsFromLastGoodAtCorruption(resolved);
  }
  writeStorageCasCorruptionMarkerFile(resolved, {
    corruptedAtMs: capCasTimestamp(corruptedAtMs, wallNow),
    salvagedBindings: salvagedBindings ?? {},
  });
  return corruptedAtMs;
}

/**
 * @param {string} resolvedPath
 */
function repairFutureCorruptionMarkerUnderLock(resolvedPath) {
  const file = readStorageCasCorruptionMarkerFileRaw(resolvedPath);
  if (!file) {
    return;
  }
  const now = casNowMs();
  if (file.corruptedAtMs > now + STORAGE_CAS_TIME_SKEW_MS) {
    writeStorageCasCorruptionMarkerFile(resolvedPath, {
      ...file,
      corruptedAtMs: now,
    });
  }
}

/**
 * @param {StorageCasCacheRecord | undefined} record
 * @returns {StorageCasCacheRecord | undefined}
 */
export function normalizeRecordTrustFields(record) {
  if (!record) {
    return record;
  }
  const seqRecheckAtMs = Math.max(
    record.seqRecheckAtMs ?? 0,
    record.seqRecheckAtMs === undefined && record.doctorSequentialRecheckOk
      ? (record.doctorSequentialRecheckAtMs ?? 0)
      : 0,
  );
  const racePassAtMs = Math.max(
    record.racePassAtMs ?? 0,
    record.racePassAtMs === undefined && record.doctorRaceRecheckOk
      ? (record.doctorRaceRecheckAtMs ?? 0)
      : 0,
  );
  const flagKind =
    record.flagKind ??
    (record.unsafeReason && isRaceRelatedCasUnsafeReason(record.unsafeReason)
      ? record.unsafeReason
      : record.unsafeReason);
  return {
    ...record,
    ...(seqRecheckAtMs ? { seqRecheckAtMs } : {}),
    ...(racePassAtMs ? { racePassAtMs } : {}),
    ...(flagKind ? { flagKind } : {}),
  };
}

/**
 * @param {string | undefined} flagKind
 */
export function isRaceFlagKind(flagKind) {
  return isRaceRelatedCasUnsafeReason(flagKind);
}

/**
 * @param {StorageCasCacheRecord | undefined} prev
 * @param {StorageCasCacheRecord | undefined} next
 */
function mergeTrustFields(prev, next) {
  const p = normalizeRecordTrustFields(prev);
  const n = normalizeRecordTrustFields(next);
  const unsafeAtMs = Math.max(p?.unsafeAtMs ?? 0, n?.unsafeAtMs ?? 0);
  const unsafeBump = (n?.unsafeAtMs ?? 0) > (p?.unsafeAtMs ?? 0);
  const explicitTrustReset =
    Boolean(n?.casUnsafe) && (n?.seqRecheckAtMs ?? 0) === 0 && (n?.racePassAtMs ?? 0) === 0;
  const seqRecheckAtMs = explicitTrustReset
    ? 0
    : unsafeBump
      ? (n?.seqRecheckAtMs ?? 0)
      : Math.max(p?.seqRecheckAtMs ?? 0, n?.seqRecheckAtMs ?? 0);
  const racePassAtMs = explicitTrustReset
    ? 0
    : unsafeBump
      ? (n?.racePassAtMs ?? 0)
      : Math.max(p?.racePassAtMs ?? 0, n?.racePassAtMs ?? 0);
  const pUnsafe = p?.unsafeAtMs ?? 0;
  const nUnsafe = n?.unsafeAtMs ?? 0;
  let flagKind = n?.flagKind ?? p?.flagKind;
  if (pUnsafe > nUnsafe) {
    flagKind = p?.flagKind ?? flagKind;
  } else if (nUnsafe >= pUnsafe) {
    flagKind = n?.flagKind ?? p?.flagKind ?? flagKind;
  }
  return {
    ...(unsafeAtMs ? { unsafeAtMs } : {}),
    ...(seqRecheckAtMs ? { seqRecheckAtMs } : { seqRecheckAtMs: 0 }),
    ...(racePassAtMs ? { racePassAtMs } : { racePassAtMs: 0 }),
    ...(flagKind ? { flagKind } : {}),
  };
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
 * @param {StorageCasCorruptionMarkerFile | null} markerFile
 */
function identificationFromCorruptionMarkerFile(markerFile) {
  if (!markerFile?.corruptedAtMs) {
    return { positivelyIdentifiedBindings: {}, salvageUnavailable: false };
  }
  const keys = Object.keys(markerFile.salvagedBindings ?? {});
  return {
    positivelyIdentifiedBindings: Object.fromEntries(keys.map((k) => [k, true])),
    salvageUnavailable: keys.length === 0,
  };
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} bindingKey
 */
export function bindingCasTrustContext(cache, bindingKey) {
  return {
    positivelyIdentifiedFromSalvage: cache.positivelyIdentifiedBindings?.[bindingKey] === true,
  };
}

/**
 * @param {StorageCasCacheRecord | undefined} record
 * @param {number} corruptedAtMs
 * @param {{ positivelyIdentifiedFromSalvage?: boolean }} [trustContext]
 */
export function isBindingCasTrustedAfterCorruption(record, corruptedAtMs, trustContext = {}) {
  const rec = normalizeRecordTrustFields(record);
  if (!rec) {
    return false;
  }
  const threshold = Math.max(rec.unsafeAtMs ?? 0, corruptedAtMs ?? 0);
  const seqAt = rec.seqRecheckAtMs ?? 0;
  const raceAt = rec.racePassAtMs ?? 0;
  if (corruptedAtMs > 0 && !trustContext.positivelyIdentifiedFromSalvage) {
    if (seqAt < threshold) {
      return false;
    }
    if (raceAt < threshold) {
      return false;
    }
  } else if (threshold > 0) {
    if (seqAt < threshold) {
      return false;
    }
    const raceFlagged =
      isRaceFlagKind(rec.flagKind) || (rec.casUnsafe && isRaceFlagKind(rec.unsafeReason));
    if (raceFlagged && raceAt < threshold) {
      return false;
    }
  }
  if (rec.casUnsafe) {
    return false;
  }
  return rec.crossDeviceCas === true;
}

/**
 * @param {Record<string, StorageCasCacheRecord>} endpoints
 * @param {Record<string, StorageCasCacheRecord>} salvaged
 * @param {number} corruptedAtMs
 */
export function mergeSalvagedUnsafeOnce(endpoints, salvaged, corruptedAtMs) {
  for (const [key, sal] of Object.entries(salvaged)) {
    const cur = endpoints[key];
    if (isBindingCasTrustedAfterCorruption(cur, corruptedAtMs, { positivelyIdentifiedFromSalvage: true })) {
      continue;
    }
    if (sal.casUnsafe) {
      const reason = sal.unsafeReason ?? cur?.unsafeReason ?? "salvaged_unsafe";
      endpoints[key] = {
        bindingKey: key,
        crossDeviceCas: false,
        casUnsafe: true,
        unsafeReason: reason,
        flagKind: sal.flagKind ?? reason,
        unsafeAtMs: Math.max(cur?.unsafeAtMs ?? 0, sal.unsafeAtMs ?? 0),
        probedAtMs: Math.max(cur?.probedAtMs ?? 0, sal.probedAtMs ?? 0),
        expiresAtMs: 0,
        seqRecheckAtMs: 0,
        racePassAtMs: 0,
      };
    } else if (!cur) {
      endpoints[key] = {
        bindingKey: key,
        crossDeviceCas: false,
        casUnsafe: false,
        probedAtMs: sal.probedAtMs ?? 0,
        expiresAtMs: 0,
      };
    }
  }
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} cachePath
 */
function attachCorruptionContext(cache, cachePath) {
  const resolved = resolveStorageCasCachePath(cachePath);
  const markerFile = readStorageCasCorruptionMarkerFile(resolved);
  const raw = markerFile?.corruptedAtMs ?? 0;
  cache.corruptedAtMs = raw ? capCasTimestamp(raw, casNowMs()) : 0;
  const identification = identificationFromCorruptionMarkerFile(markerFile);
  cache.positivelyIdentifiedBindings = identification.positivelyIdentifiedBindings;
  cache.salvageUnavailable = identification.salvageUnavailable;
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} cachePath
 */
function ensureRecoverySalvageMerged(cache, cachePath) {
  const corruptedAtMs = cache.corruptedAtMs ?? 0;
  if (!corruptedAtMs) {
    return;
  }
  const mergedFor = cache.salvageMergedForCorruptedAtMs ?? 0;
  if (mergedFor >= corruptedAtMs) {
    return;
  }
  const markerFile = readStorageCasCorruptionMarkerFile(cachePath);
  const salvaged = salvagedEndpointRecordsFromMarkerSnapshot(markerFile?.salvagedBindings);
  mergeSalvagedUnsafeOnce(cache.endpoints, salvaged, corruptedAtMs);
  cache.salvageMergedForCorruptedAtMs = corruptedAtMs;
}

/**
 * @param {string} resolvedPath
 */
function sweepStaleCasCacheArtifacts(resolvedPath) {
  const dir = path.dirname(resolvedPath);
  const base = path.basename(resolvedPath);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(base)) {
      continue;
    }
    const isTempArtifact =
      name.includes(".locktmp") ||
      name.includes(".tmp") ||
      name.endsWith(STORAGE_CAS_CACHE_LAST_GOOD_SUFFIX + ".tmp") ||
      name.includes(".corruption-marker.");
    if (!isTempArtifact) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs >= STORAGE_CAS_LOCK_MAX_AGE_MS) {
        fs.unlinkSync(full);
      }
    } catch {
      /* ignore */
    }
  }
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
  const probedAtMs = capCasTimestamp(Number(record.probedAtMs), nowMs);
  const maxExpires = probedAtMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS;
  let expiresAtMs = Number(record.expiresAtMs);
  if (expiresAtMs > maxExpires) {
    expiresAtMs = maxExpires;
  }
  const stale = expiresAtMs <= nowMs;
  const unsafe = Boolean(record.casUnsafe);
  return {
    ...record,
    probedAtMs,
    expiresAtMs,
    stale,
    unsafe,
    untrusted: expiresAtMs !== Number(record.expiresAtMs) || probedAtMs !== Number(record.probedAtMs),
  };
}

/**
 * @param {string} [cachePath]
 */
export function loadStorageCasCache(cachePath) {
  const resolvedPath = resolveStorageCasCachePath(cachePath);
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptCacheFile(resolvedPath);
      const salvagedEndpoints = loadSalvagedEndpointsFromLastGood(resolvedPath) ?? undefined;
      const corruptedAtMs = bumpStorageCasCorruptionMarker(resolvedPath);
      return {
        v: STORAGE_CAS_CACHE_VERSION,
        endpoints: {},
        corruptedAtMs,
        fileCorrupt: true,
        salvagedEndpoints,
      };
    }
    const endpoints =
      parsed.endpoints && typeof parsed.endpoints === "object" && !Array.isArray(parsed.endpoints)
        ? /** @type {Record<string, StorageCasCacheRecord>} */ (parsed.endpoints)
        : {};
    const salvageMergedForCorruptedAtMs =
      typeof parsed.salvageMergedForCorruptedAtMs === "number"
        ? parsed.salvageMergedForCorruptedAtMs
        : undefined;
    const cache = {
      v: STORAGE_CAS_CACHE_VERSION,
      endpoints,
      fileCorrupt: false,
      ...(salvageMergedForCorruptedAtMs !== undefined ? { salvageMergedForCorruptedAtMs } : {}),
    };
    attachCorruptionContext(cache, resolvedPath);
    return cache;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { v: STORAGE_CAS_CACHE_VERSION, endpoints: {}, fileCorrupt: false };
    }
    backupCorruptCacheFile(resolvedPath);
    const salvagedEndpoints = loadSalvagedEndpointsFromLastGood(resolvedPath) ?? undefined;
    const corruptedAtMs = bumpStorageCasCorruptionMarker(resolvedPath);
    return {
      v: STORAGE_CAS_CACHE_VERSION,
      endpoints: {},
      corruptedAtMs,
      fileCorrupt: true,
      salvagedEndpoints,
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
    endpoints: cache.endpoints,
    ...(cache.salvageMergedForCorruptedAtMs
      ? { salvageMergedForCorruptedAtMs: cache.salvageMergedForCorruptedAtMs }
      : {}),
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
/**
 * @param {string} lockPath
 */
function readLockPartialPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const match = raw.match(/"pid"\s*:\s*(\d+)/);
    if (match) {
      return Number(match[1]);
    }
  } catch {
    /* ignore */
  }
  return NaN;
}

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
    const partialPid = readLockPartialPid(lockPath);
    if (Number.isInteger(partialPid) && partialPid > 0 && !isProcessAlive(partialPid)) {
      try {
        fs.unlinkSync(lockPath);
        lastCasCacheLockBreakHint =
          "Removed a tokenless CAS cache lock left by a dead process (pid no longer running).";
      } catch {
        /* ignore */
      }
      return;
    }
    let ageMs = STORAGE_CAS_LOCK_MAX_AGE_MS + 1;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return;
    }
    if (ageMs > STORAGE_CAS_LOCK_MAX_AGE_MS) {
      try {
        fs.unlinkSync(lockPath);
        lastCasCacheLockBreakHint =
          "Removed a stale tokenless or unreadable CAS cache lock file (older than 60s). If this repeats, check for crashed processes holding ~/.infinitecontext/storage-cas-probe-cache.json.lock";
      } catch {
        /* ignore */
      }
    }
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
    lastCasCacheLockBreakHint =
      "Removed a stale CAS cache lock (owner pid no longer running or lock older than 60s).";
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
    return ownerToken;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return null;
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
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
/**
 * @param {StorageCasCacheRecord | undefined} prev
 * @param {StorageCasCacheRecord} next
 * @param {{ allowClearUnsafe?: boolean }} [mergeOptions]
 */
export function mergeStorageCasCacheRecords(prev, next, mergeOptions = {}) {
  const prevN = normalizeRecordTrustFields(prev);
  const nextN = normalizeRecordTrustFields(next);
  if (!prevN) {
    return { ...nextN, ...mergeTrustFields(undefined, nextN) };
  }
  if (prevN.casUnsafe && !mergeOptions.allowClearUnsafe) {
    if (nextN.casUnsafe) {
      const unsafeAtMs = Math.max(prevN.unsafeAtMs ?? 0, nextN.unsafeAtMs ?? 0);
      if (unsafeAtMs > (prevN.unsafeAtMs ?? 0)) {
        return {
          ...nextN,
          unsafeAtMs,
          seqRecheckAtMs: 0,
          racePassAtMs: 0,
          flagKind: nextN.flagKind ?? nextN.unsafeReason ?? prevN.flagKind,
          crossDeviceCas: false,
          casUnsafe: true,
        };
      }
      return {
        ...prevN,
        ...mergeTrustFields(prevN, nextN),
        bindingKey: nextN.bindingKey,
        crossDeviceCas: false,
        casUnsafe: true,
      };
    }
    return {
      ...prevN,
      ...mergeTrustFields(prevN, nextN),
      bindingKey: nextN.bindingKey,
      probedAtMs: Math.max(prevN.probedAtMs ?? 0, nextN.probedAtMs ?? 0),
      crossDeviceCas: false,
      casUnsafe: true,
    };
  }
  return { ...nextN, ...mergeTrustFields(prevN, nextN) };
}

/**
 * @param {string} cachePath
 * @param {(cache: StorageCasCacheFile) => void} mutator
 * @param {{ allowClearUnsafe?: boolean }} [options]
 */
export function mutateStorageCasCache(cachePath, mutator, options = {}) {
  const resolvedPath = resolveStorageCasCachePath(cachePath);
  const lockPath = `${resolvedPath}.lock`;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  sweepStaleCasCacheArtifacts(resolvedPath);
  lastCasCacheLockBreakHint = undefined;
  const deadline = Date.now() + 30_000;
  const ownerToken = acquireCacheLockWithBackoff(lockPath, deadline);
  if (!ownerToken) {
    if (fs.existsSync(lockPath) && !readLockMetadata(lockPath)) {
      const heldHint =
        "A tokenless or unreadable CAS cache lock is still held (younger than 60s). Wait for the other process or remove ~/.infinitecontext/storage-cas-probe-cache.json.lock only if you are sure no writer is active.";
      console.error(`storage-cas-cache: ${heldHint}`);
      lastCasCacheLockBreakHint = lastCasCacheLockBreakHint ?? heldHint;
    }
    const hint = lastCasCacheLockBreakHint ? ` ${lastCasCacheLockBreakHint}` : "";
    throw new Error(`Timed out waiting for storage CAS cache lock.${hint}`);
  }
  try {
    repairFutureCorruptionMarkerUnderLock(resolvedPath);
    const cache = loadStorageCasCache(resolvedPath);
    attachCorruptionContext(cache, resolvedPath);
    ensureRecoverySalvageMerged(cache, resolvedPath);
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
  const corruptedAtMs = cache.corruptedAtMs ?? 0;
  const record = normalizeRecordTrustFields(cache.endpoints[bindingKey]);
  if (!record) {
    if (corruptedAtMs) {
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
  if (
    corruptedAtMs &&
    !isBindingCasTrustedAfterCorruption(record, corruptedAtMs, bindingCasTrustContext(cache, bindingKey))
  ) {
    return {
      ...normalized,
      crossDeviceCas: false,
      unsafe: true,
      casUnsafe: normalized.casUnsafe ?? true,
      stale: false,
    };
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
    const prevN = normalizeRecordTrustFields(prev);
    const wallNowMs = casNowMs();
    const cappedRequestNow = capCasTimestamp(nowMs, wallNowMs);
    const latestPass = Math.max(prevN?.seqRecheckAtMs ?? 0, prevN?.racePassAtMs ?? 0);
    const unsafeFromPass = latestPass > 0 ? latestPass + 1 : 0;
    const unsafeAtMs = Math.max(prev?.unsafeAtMs ?? 0, cappedRequestNow, wallNowMs, unsafeFromPass);
    setStorageCasCacheRecord(cache, bindingKey, {
      bindingKey,
      crossDeviceCas: false,
      casUnsafe: true,
      unsafeReason: reason,
      flagKind: reason,
      unsafeAtMs,
      probedAtMs: capCasTimestamp(nowMs, wallNowMs),
      expiresAtMs: 0,
      seqRecheckAtMs: 0,
      racePassAtMs: 0,
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
  const cappedNow = capCasTimestamp(nowMs);
  const expiresAtMs = Math.min(
    cappedNow + DEFAULT_STORAGE_CAS_CACHE_TTL_MS,
    cappedNow + DEFAULT_STORAGE_CAS_CACHE_TTL_MS,
  );
  mutateStorageCasCache(cachePath, (cache) => {
    setStorageCasCacheRecord(cache, bindingKey, {
      bindingKey,
      crossDeviceCas: true,
      probedAtMs: cappedNow,
      expiresAtMs,
    });
  });
}

/**
 * @param {StorageCasCacheRecord | undefined} prev
 * @param {number} nowMs
 * @param {number} corruptedAtMs
 * @param {{ positivelyIdentifiedFromSalvage?: boolean }} trustContext
 */
function doctorRecheckSuccessRecord(prev, nowMs, corruptedAtMs, trustContext) {
  const prevN = normalizeRecordTrustFields(prev);
  const expiresAtMs = Math.min(nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS);
  const seqRecheckAtMs = Math.max(prevN?.seqRecheckAtMs ?? 0, nowMs);
  const racePassAtMs = prevN?.racePassAtMs ?? 0;
  const draft = {
    bindingKey: prevN?.bindingKey ?? "",
    crossDeviceCas: false,
    probedAtMs: nowMs,
    expiresAtMs: 0,
    casUnsafe: Boolean(prevN?.casUnsafe),
    unsafeReason: prevN?.unsafeReason,
    flagKind: prevN?.flagKind,
    unsafeAtMs: prevN?.unsafeAtMs,
    seqRecheckAtMs,
    racePassAtMs,
  };
  if (
    isBindingCasTrustedAfterCorruption(
      { ...draft, casUnsafe: false, crossDeviceCas: true },
      corruptedAtMs,
      trustContext,
    )
  ) {
    return {
      bindingKey: draft.bindingKey,
      crossDeviceCas: true,
      probedAtMs: nowMs,
      expiresAtMs,
      casUnsafe: false,
      unsafeReason: undefined,
      unsafeAtMs: undefined,
      flagKind: undefined,
      seqRecheckAtMs,
      racePassAtMs,
    };
  }
  return draft;
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 */
export function recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey) {
  mutateStorageCasCache(
    cachePath,
    (cache) => {
      const nowMs = capCasTimestamp(casNowMs());
      const prev = cache.endpoints[bindingKey];
      const corruptedAtMs = cache.corruptedAtMs ?? 0;
      setStorageCasCacheRecord(cache, bindingKey, {
        ...doctorRecheckSuccessRecord(prev, nowMs, corruptedAtMs, bindingCasTrustContext(cache, bindingKey)),
        bindingKey,
      });
    },
    { allowClearUnsafe: true },
  );
}

/**
 * @param {string} [cachePath]
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function crossDeviceCasEnabledAfterDoctorRecheck(cachePath, bindingKey, nowMs = Date.now()) {
  const resolved = resolveStorageCasCachePath(cachePath);
  const cache = loadStorageCasCache(resolved);
  attachCorruptionContext(cache, resolved);
  const record = getStorageCasCacheRecord(cache, bindingKey, nowMs);
  return Boolean(record && record.crossDeviceCas === true && !record.unsafe && !record.casUnsafe);
}

/**
 * @param {string} [cachePath]
 */
export function resetStorageCasProbeCache(cachePath) {
  const resolved = resolveStorageCasCachePath(cachePath);
  mutateStorageCasCache(resolved, (cache) => {
    const nowMs = capCasTimestamp(casNowMs());
    const salvagedBindings = snapshotSalvagedBindingsFromEndpoints(cache.endpoints);
    const corruptedAtMs = bumpStorageCasCorruptionMarker(resolved, nowMs, { salvagedBindings });
    cache.corruptedAtMs = corruptedAtMs;
    delete cache.salvageMergedForCorruptedAtMs;
    for (const [key, rec] of Object.entries({ ...cache.endpoints })) {
      const norm = normalizeRecordTrustFields(rec);
      setStorageCasCacheRecord(cache, key, {
        ...norm,
        bindingKey: key,
        crossDeviceCas: false,
        seqRecheckAtMs: 0,
        racePassAtMs: 0,
        casUnsafe: Boolean(norm?.casUnsafe || norm?.flagKind),
      });
    }
  });
  try {
    fs.unlinkSync(storageCasCacheLastGoodPath(resolved));
  } catch {
    /* ignore — reset must not leave a last-good snapshot after save */
  }
  sweepStaleCasCacheArtifacts(resolved);
}

/**
 * @param {string} cachePath
 * @param {string} bindingKey
 * @param {number} [nowMs]
 */
export function recordStorageCasDoctorRaceSuccess(cachePath, bindingKey) {
  mutateStorageCasCache(
    cachePath,
    (cache) => {
      const nowMs = capCasTimestamp(casNowMs());
      const prev = normalizeRecordTrustFields(cache.endpoints[bindingKey]);
      const expiresAtMs = Math.min(nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS, nowMs + DEFAULT_STORAGE_CAS_CACHE_TTL_MS);
      const racePassAtMs = Math.max(prev?.racePassAtMs ?? 0, nowMs);
      const seqRecheckAtMs = prev?.seqRecheckAtMs ?? 0;
      const draft = {
        ...prev,
        bindingKey,
        racePassAtMs,
        seqRecheckAtMs,
        crossDeviceCas: false,
        casUnsafe: prev?.casUnsafe ?? false,
        probedAtMs: nowMs,
        expiresAtMs: 0,
      };
      const corruptedAtMs = cache.corruptedAtMs ?? 0;
      if (
        isBindingCasTrustedAfterCorruption(
          { ...draft, casUnsafe: false, crossDeviceCas: true },
          corruptedAtMs,
          bindingCasTrustContext(cache, bindingKey),
        )
      ) {
        setStorageCasCacheRecord(cache, bindingKey, {
          bindingKey,
          crossDeviceCas: true,
          probedAtMs: nowMs,
          expiresAtMs,
          casUnsafe: false,
          unsafeReason: undefined,
          unsafeAtMs: undefined,
          flagKind: undefined,
          seqRecheckAtMs,
          racePassAtMs,
        });
        return;
      }
      setStorageCasCacheRecord(cache, bindingKey, draft);
    },
    { allowClearUnsafe: true },
  );
}

/**
 * @param {StorageCasCacheFile} cache
 * @param {string} cachePath
 */
export function attachStorageCasCorruptionContextForRead(cache, cachePath) {
  attachCorruptionContext(cache, resolveStorageCasCachePath(cachePath));
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
