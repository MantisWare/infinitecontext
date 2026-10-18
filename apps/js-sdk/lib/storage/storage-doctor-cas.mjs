import {
  markStorageCasUnsafePersisted,
  recordStorageCasDoctorRaceSuccess,
  resetStorageCasProbeCache,
  storageCasProbeBindingKey,
} from "./storage-cas-cache.mjs";
import { recheckStorageCasProbe } from "./storage-cas-init.mjs";
import { probeCrossDeviceCasRace } from "./storage-cas-race-probe.mjs";
import { sweepStaleCasProbeObjects } from "./storage-cas-probe-sweep.mjs";
import {
  openS3StorageCasProbeSession,
  resetS3CasRaceDoubleWinForTests,
} from "./storage-s3-cas-probe-session.mjs";
import { resolveS3ObjectStoreConfig } from "./s3-config.mjs";
import { StorageError } from "./errors.mjs";

/**
 * @param {{ config?: Record<string, unknown>, env?: NodeJS.ProcessEnv, rounds?: number, cachePath?: string }} options
 */
export async function runStorageDoctorCasRace(options = {}) {
  resetS3CasRaceDoubleWinForTests();
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const s3 = resolveS3ObjectStoreConfig(config, env);
  const bindingKey = storageCasProbeBindingKey({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    prefix: s3.prefix,
  });
  const session = await openS3StorageCasProbeSession({ config, env, cachePath: options.cachePath });
  try {
    await sweepStaleCasProbeObjects(session.adapter);
    const rounds = options.rounds ?? 20;
    const result = await probeCrossDeviceCasRace(session.adapter, { rounds });
    if (!result.ok) {
      if (result.detail === "double_win") {
        markStorageCasUnsafePersisted(options.cachePath, bindingKey, `race_${result.detail}`, Date.now());
      }
      return {
        bindingKey,
        ...result,
        rounds,
        inconclusive: result.detail !== "double_win",
        persistedUnsafe: result.detail === "double_win",
      };
    }
    recordStorageCasDoctorRaceSuccess(options.cachePath, bindingKey);
    return { bindingKey, ...result, rounds, inconclusive: false, persistedUnsafe: false };
  } finally {
    await session.close();
  }
}

/**
 * @param {{ config?: Record<string, unknown>, env?: NodeJS.ProcessEnv, cachePath?: string }} options
 */
/**
 * @param {{ cachePath?: string }} [options]
 */
export function runStorageDoctorResetCasCache(options = {}) {
  resetStorageCasProbeCache(options.cachePath);
  return { ok: true, reset: true };
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
  const session = await openS3StorageCasProbeSession({ config, env, cachePath: options.cachePath });
  try {
    const recheck = await recheckStorageCasProbe(session.adapter, {
      bindingKey,
      cachePath: options.cachePath,
    });
    if (!recheck.ok) {
      throw new StorageError(
        "CAS recheck failed; crossDeviceCas remains disabled until the backend honours conditional writes",
        "invalid_argument",
      );
    }
    return { bindingKey, ok: true, crossDeviceCas: recheck.crossDeviceCas };
  } finally {
    await session.close();
  }
}
