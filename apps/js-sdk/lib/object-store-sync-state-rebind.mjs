import {
  rebindObjectStoreSyncStateForBackend,
  resolveObjectStoreSyncBindingKey,
} from "./object-store-sync-binding.mjs";

/**
 * @param {{ load: () => import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState, save: (s: import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState) => void | Promise<void> } | null | undefined} localState
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ rootDir?: string, backendId?: string }} [options]
 */
export async function maybeRebindPersistedObjectStoreState(
  localState,
  config = {},
  env = process.env,
  options = {},
) {
  if (!localState) return;
  const bindingKey = resolveObjectStoreSyncBindingKey(config, env, options);
  const loaded = localState.load();
  const rebound = rebindObjectStoreSyncStateForBackend(loaded, bindingKey);
  const mapChanged =
    JSON.stringify(rebound.manifestGenerationHighWaterByBindingKey ?? {}) !==
    JSON.stringify(loaded.manifestGenerationHighWaterByBindingKey ?? {});
  if (
    rebound.storageBindingKey !== loaded.storageBindingKey ||
    rebound.manifestGenerationHighWater !== loaded.manifestGenerationHighWater ||
    mapChanged
  ) {
    await localState.save(rebound);
  }
}
