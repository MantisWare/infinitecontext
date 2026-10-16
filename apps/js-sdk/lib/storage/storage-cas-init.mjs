import {
  attachStorageCasCorruptionContextForRead,
  crossDeviceCasEnabledAfterDoctorRecheck,
  getStorageCasCacheRecord,
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  recordStorageCasDoctorRecheckSuccess,
  recordStorageCasInitProbeSuccess,
} from "./storage-cas-cache.mjs";
import { sweepStaleCasProbeObjects } from "./storage-cas-probe-sweep.mjs";
import { probeCrossDeviceCas } from "./storage-cas-probe.mjs";
import { STORAGE_CAPABILITIES } from "./types.mjs";

/**
 * @typedef {'read-only' | 'read-write' | 'force-recheck' | 'probe-session'} StorageCasInitMode
 */

/**
 * @param {boolean | null} crossDeviceCas crossDeviceCas enabled, or null when unknown (read-only, no cache)
 */
export function crossDeviceCasCapabilitiesFromProbeResult(crossDeviceCas) {
  const base = [
    STORAGE_CAPABILITIES.get,
    STORAGE_CAPABILITIES.head,
    STORAGE_CAPABILITIES.put,
    STORAGE_CAPABILITIES.list,
    STORAGE_CAPABILITIES.delete,
  ];
  if (crossDeviceCas !== true) {
    return base;
  }
  return [
    ...base,
    STORAGE_CAPABILITIES.conditionalCreate,
    STORAGE_CAPABILITIES.conditionalReplace,
    STORAGE_CAPABILITIES.strongListAfterWrite,
    STORAGE_CAPABILITIES.crossDeviceCas,
  ];
}

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {{
 *   bindingKey: string,
 *   mode?: StorageCasInitMode,
 *   cachePath?: string,
 *   ttlMs?: number,
 *   nowMs?: number,
 *   runBasicProbe?: (adapter: import("./types.mjs").StorageAdapter) => Promise<boolean>,
 *   sweepProbeKeys?: boolean,
 * }} options
 */
export async function resolveCrossDeviceCasForAdapterInit(adapter, options) {
  const mode = options.mode ?? "read-write";
  const nowMs = options.nowMs ?? Date.now();
  const cachePath = options.cachePath;
  const runBasicProbe = options.runBasicProbe ?? probeCrossDeviceCas;
  const cache = loadStorageCasCache(cachePath ?? undefined);
  attachStorageCasCorruptionContextForRead(cache, cachePath ?? undefined);
  const cached = getStorageCasCacheRecord(cache, options.bindingKey, nowMs);

  if (cache.fileCorrupt || (cached && cached.unsafe)) {
    return {
      crossDeviceCas: false,
      source: cache.fileCorrupt ? "corrupt_cache" : "cas_unsafe",
      probed: false,
      cache,
    };
  }

  if (mode === "read-only") {
    if (cached && !cached.stale) {
      return {
        crossDeviceCas: cached.crossDeviceCas,
        source: "cache",
        probed: false,
        cache,
      };
    }
    return {
      crossDeviceCas: null,
      source: "unknown",
      probed: false,
      cache,
    };
  }

  const cacheFresh = cached && !cached.stale && mode !== "force-recheck";
  if (cacheFresh) {
    return {
      crossDeviceCas: cached.crossDeviceCas,
      source: "cache",
      probed: false,
      cache,
    };
  }

  if (options.sweepProbeKeys !== false) {
    await sweepStaleCasProbeObjects(adapter);
  }
  const basicOk = await runBasicProbe(adapter);
  if (!basicOk) {
    markStorageCasUnsafePersisted(cachePath, options.bindingKey, "basic_probe_failed", nowMs);
    return {
      crossDeviceCas: false,
      source: "probe_failed",
      probed: true,
      cache: loadStorageCasCache(cachePath),
    };
  }
  recordStorageCasInitProbeSuccess(cachePath, options.bindingKey, nowMs);
  return {
    crossDeviceCas: true,
    source: "probe",
    probed: true,
    cache: loadStorageCasCache(cachePath),
  };
}

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {{ bindingKey: string, cachePath?: string, ttlMs?: number, nowMs?: number, runBasicProbe?: (a: import("./types.mjs").StorageAdapter) => Promise<boolean> }} options
 */
export async function recheckStorageCasProbe(adapter, options) {
  const nowMs = options.nowMs ?? Date.now();
  const runBasicProbe = options.runBasicProbe ?? probeCrossDeviceCas;
  const cachePath = options.cachePath;
  await sweepStaleCasProbeObjects(adapter);
  const basicOk = await runBasicProbe(adapter);
  if (!basicOk) {
    markStorageCasUnsafePersisted(cachePath, options.bindingKey, "recheck_failed", nowMs);
    return { ok: false, crossDeviceCas: false };
  }
  recordStorageCasDoctorRecheckSuccess(cachePath, options.bindingKey, nowMs);
  const crossDeviceCas = crossDeviceCasEnabledAfterDoctorRecheck(cachePath, options.bindingKey, nowMs);
  return { ok: true, crossDeviceCas };
}
