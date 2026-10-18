import { createS3StorageAdapter } from "./s3-adapter.mjs";
import { resolveS3ObjectStoreConfig } from "./s3-config.mjs";
import { StorageError } from "./errors.mjs";
import { CAS_PROBE_OBJECT_PREFIXES } from "./storage-cas-probe-sweep.mjs";
/** @type {boolean} */
let s3CasRaceDoubleWinForTests = false;

/** @param {boolean} active */
export function setS3CasRaceDoubleWinForTests(active) {
  s3CasRaceDoubleWinForTests = active === true;
}

/** Reset CAS race double-win simulation (tests only). */
export function resetS3CasRaceDoubleWinForTests() {
  s3CasRaceDoubleWinForTests = false;
}

function isS3CasRaceDoubleWinActive() {
  return s3CasRaceDoubleWinForTests;
}

/**
 * @param {string} key
 */
function isCasProbeObjectKey(key) {
  const k = String(key);
  return CAS_PROBE_OBJECT_PREFIXES.some((prefix) => k.startsWith(prefix));
}

/**
 * Adapter that allows conditional writes only under ic-cas-probe/ and ic-cas-race/.
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 */
export function wrapStorageAdapterCasProbeSession(adapter) {
  return {
    ...adapter,
    async put(key, body, putOptions) {
      if (!isCasProbeObjectKey(key)) {
        throw new StorageError(`CAS probe session refuses put outside probe prefixes: ${key}`, "invalid_argument");
      }
      return adapter.put(key, body, putOptions);
    },
    async delete(key, deleteOptions) {
      if (!isCasProbeObjectKey(key)) {
        throw new StorageError(
          `CAS probe session refuses delete outside probe prefixes: ${key}`,
          "invalid_argument",
        );
      }
      return adapter.delete(key, deleteOptions);
    },
  };
}

/**
 * Test-only hook: drops ifNoneMatch:"*" on ic-cas-race/ puts (simulates broken CAS).
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 */
export function wrapCasRaceDoubleWinTestHook(adapter) {
  const inner = adapter;
  return {
    ...inner,
    put(key, body, putOptions) {
      if (putOptions?.ifNoneMatch === "*" && String(key).includes("ic-cas-race/")) {
        return inner.put(key, body, {});
      }
      return inner.put(key, body, putOptions);
    },
  };
}

/**
 * @param {{ config?: Record<string, unknown>, env?: NodeJS.ProcessEnv, cachePath?: string }} options
 */
export async function openS3StorageCasProbeSession(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const s3 = resolveS3ObjectStoreConfig(config, env);
  const adapter = createS3StorageAdapter({
    bucket: s3.bucket,
    prefix: s3.prefix,
    region: s3.region,
    endpoint: s3.endpoint,
  });
  await adapter.init({ mode: "probe-session", cachePath: options.cachePath });
  let sessionAdapter = wrapStorageAdapterCasProbeSession(adapter);
  if (isS3CasRaceDoubleWinActive()) {
    sessionAdapter = wrapCasRaceDoubleWinTestHook(sessionAdapter);
  }
  return {
    adapter: sessionAdapter,
    close: () => adapter.close(),
  };
}
