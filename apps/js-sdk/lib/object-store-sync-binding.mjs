import fs from "node:fs";
import path from "node:path";

import { readConfigFile } from "./client-config.mjs";
import { resolveFolderObjectStoreRootDir } from "./storage/folder-object-store.mjs";
import { resolveLocalObjectStoreRootDir } from "./storage/local-object-store.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./storage/folder-adapter.mjs";
import { resolveS3ObjectStoreConfig, S3_OBJECT_STORE_BACKEND_ID } from "./storage/s3-config.mjs";
import { resolveStorageBackendId } from "./sync-storage-backend.mjs";

/**
 * @param {string} rootPath
 */
export function resolveStorageRootRealpathForBinding(rootPath) {
  const resolved = path.resolve(rootPath);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return resolved;
    }
    throw error;
  }
}

/**
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ rootDir?: string, backendId?: string }} [options]
 */
/**
 * Binding key for vault trust / manifest high-water against a store root (migrate, doctor, trust audit).
 *
 * @param {string} storeRootDir
 * @param {string} backendId e.g. `local-filesystem` or `folder`
 */
export function resolveObjectStoreTrustBindingKey(storeRootDir, backendId) {
  return resolveObjectStoreSyncBindingKey({}, process.env, {
    rootDir: storeRootDir,
    backendId,
  });
}

export function resolveObjectStoreSyncBindingKey(
  config = readConfigFile(),
  env = process.env,
  options = {},
) {
  const backendId = options.backendId ?? resolveStorageBackendId(config);
  if (backendId === S3_OBJECT_STORE_BACKEND_ID) {
    const s3 = resolveS3ObjectStoreConfig(config, env);
    const prefix = String(s3.prefix ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    return `${S3_OBJECT_STORE_BACKEND_ID}:${s3.bucket}:${prefix}`;
  }
  if (options.rootDir) {
    return `${backendId}:${resolveStorageRootRealpathForBinding(options.rootDir)}`;
  }
  if (backendId === FOLDER_STORAGE_ADAPTER_ID) {
    const root = resolveFolderObjectStoreRootDir(config, env);
    return `${backendId}:${resolveStorageRootRealpathForBinding(root)}`;
  }
  const root = resolveLocalObjectStoreRootDir({ config, env });
  return `${backendId}:${resolveStorageRootRealpathForBinding(root)}`;
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 */
export function ensureManifestHighWaterBindingMap(state) {
  if (!state.manifestGenerationHighWaterByBindingKey) {
    state.manifestGenerationHighWaterByBindingKey = {};
  }
  return state.manifestGenerationHighWaterByBindingKey;
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 * @param {string} bindingKey
 */
export function migrateLegacyManifestHighWaterToBindingMap(state, bindingKey) {
  const map = ensureManifestHighWaterBindingMap(state);
  const legacy = Number(state.manifestGenerationHighWater ?? 0);
  if (Object.keys(map).length === 0 && Number.isFinite(legacy) && legacy > 0) {
    map[bindingKey] = legacy;
  }
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 * @param {string} bindingKey
 */
export function syncManifestHighWaterViewForBinding(state, bindingKey) {
  migrateLegacyManifestHighWaterToBindingMap(state, bindingKey);
  state.storageBindingKey = bindingKey;
  const map = ensureManifestHighWaterBindingMap(state);
  state.manifestGenerationHighWater = map[bindingKey] ?? 0;
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 * @param {string} bindingKey
 */
export function rebindObjectStoreSyncStateForBackend(state, bindingKey) {
  /** @type {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} */
  const next = {
    ...state,
    manifestGenerationHighWaterByBindingKey: {
      ...(state.manifestGenerationHighWaterByBindingKey ?? {}),
    },
  };
  syncManifestHighWaterViewForBinding(next, bindingKey);
  return next;
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 * @param {string} bindingKey
 */
export function manifestGenerationHighWaterForBinding(state, bindingKey) {
  const map = state.manifestGenerationHighWaterByBindingKey;
  if (map && bindingKey in map) {
    return map[bindingKey] ?? 0;
  }
  if (state.storageBindingKey === bindingKey) {
    return state.manifestGenerationHighWater ?? 0;
  }
  return 0;
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 * @param {string} bindingKey
 * @param {number} generation
 */
export function recordManifestGenerationHighWaterForBinding(state, bindingKey, generation) {
  if (!Number.isFinite(generation) || generation < 0) return;
  const map = ensureManifestHighWaterBindingMap(state);
  map[bindingKey] = Math.max(map[bindingKey] ?? 0, generation);
  if (state.storageBindingKey === bindingKey) {
    state.manifestGenerationHighWater = map[bindingKey];
  }
}
