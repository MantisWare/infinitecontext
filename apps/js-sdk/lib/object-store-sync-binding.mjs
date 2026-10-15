import path from "node:path";

import { readConfigFile } from "./client-config.mjs";
import { resolveFolderObjectStoreRootDir } from "./storage/folder-object-store.mjs";
import { resolveLocalObjectStoreRootDir } from "./storage/local-object-store.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./storage/folder-adapter.mjs";
import { resolveStorageBackendId } from "./sync-storage-backend.mjs";

/**
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveObjectStoreSyncBindingKey(config = readConfigFile(), env = process.env) {
  const backendId = resolveStorageBackendId(config);
  if (backendId === FOLDER_STORAGE_ADAPTER_ID) {
    const root = path.resolve(resolveFolderObjectStoreRootDir(config, env));
    return `folder:${root}`;
  }
  const root = path.resolve(resolveLocalObjectStoreRootDir({ config, env }));
  return `${backendId}:${root}`;
}

/**
 * @param {import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} state
 * @param {string} bindingKey
 */
export function rebindObjectStoreSyncStateForBackend(state, bindingKey) {
  const next = { ...state };
  if (next.storageBindingKey !== bindingKey) {
    next.storageBindingKey = bindingKey;
    next.manifestGenerationHighWater = 0;
    next.verifiedManifestGeneration = undefined;
  }
  return next;
}
