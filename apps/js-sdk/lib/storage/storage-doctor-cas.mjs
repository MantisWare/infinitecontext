import { markStorageCasUnsafe, saveStorageCasCache, storageCasProbeBindingKey } from "./storage-cas-cache.mjs";
import { loadStorageCasCache } from "./storage-cas-cache.mjs";
import { recheckStorageCasProbe } from "./storage-cas-init.mjs";
import { probeCrossDeviceCasRace } from "./storage-cas-race-probe.mjs";
import { sweepStaleCasProbeObjects } from "./storage-cas-probe-sweep.mjs";
import { createS3StorageAdapter } from "./s3-adapter.mjs";
import { resolveS3ObjectStoreConfig } from "./s3-config.mjs";
import { StorageError } from "./errors.mjs";

/**
 * @param {{ config?: Record<string, unknown>, env?: NodeJS.ProcessEnv, rounds?: number, cachePath?: string }} options
 */
export async function runStorageDoctorCasRace(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const s3 = resolveS3ObjectStoreConfig(config, env);
  const bindingKey = storageCasProbeBindingKey({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    prefix: s3.prefix,
  });
  const adapter = createS3StorageAdapter({
    bucket: s3.bucket,
    prefix: s3.prefix,
    region: s3.region,
    endpoint: s3.endpoint,
  });
  await adapter.init({ mode: "read-only" });
  try {
    await sweepStaleCasProbeObjects(adapter);
    const rounds = options.rounds ?? 20;
    const result = await probeCrossDeviceCasRace(adapter, { rounds });
    if (!result.ok) {
      const cache = loadStorageCasCache(options.cachePath);
      markStorageCasUnsafe(cache, bindingKey, `race_${result.detail}`, Date.now());
      saveStorageCasCache(cache, options.cachePath);
    }
    return { bindingKey, ...result, rounds };
  } finally {
    await adapter.close();
  }
}

/**
 * @param {{ config?: Record<string, unknown>, env?: NodeJS.ProcessEnv, cachePath?: string }} options
 */
export async function runStorageDoctorRecheckCas(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const s3 = resolveS3ObjectStoreConfig(config, env);
  const bindingKey = storageCasProbeBindingKey({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    prefix: s3.prefix,
  });
  const adapter = createS3StorageAdapter({
    bucket: s3.bucket,
    prefix: s3.prefix,
    region: s3.region,
    endpoint: s3.endpoint,
  });
  await adapter.init({ mode: "read-only" });
  try {
    const recheck = await recheckStorageCasProbe(adapter, { bindingKey, cachePath: options.cachePath });
    if (!recheck.ok) {
      throw new StorageError(
        "CAS recheck failed; crossDeviceCas remains disabled until the backend honours conditional writes",
        "invalid_argument",
      );
    }
    return { bindingKey, ok: true, crossDeviceCas: true };
  } finally {
    await adapter.close();
  }
}
