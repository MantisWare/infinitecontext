import {
  rebindObjectStoreSyncStateForBackend,
  resolveObjectStoreSyncBindingKey,
} from "./object-store-sync-binding.mjs";

/**
 * @param {{ load: () => import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState, save: (s: import("./object-store-local-sync-state.mjs").ObjectStoreLocalSyncState) => void | Promise<void> } | null | undefined} localState
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function maybeRebindPersistedObjectStoreState(localState, config = {}, env = process.env) {
  if (!localState) return;
  const bindingKey = resolveObjectStoreSyncBindingKey(config, env);
  const loaded = localState.load();
  const rebound = rebindObjectStoreSyncStateForBackend(loaded, bindingKey);
  if (
    rebound.storageBindingKey !== loaded.storageBindingKey ||
    rebound.manifestGenerationHighWater !== loaded.manifestGenerationHighWater
  ) {
    localState.save(rebound);
  }
}
