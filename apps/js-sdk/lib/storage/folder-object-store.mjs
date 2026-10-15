import path from "node:path";

import { StorageError } from "./errors.mjs";
import { createFolderStorageAdapter, FOLDER_STORAGE_ADAPTER_ID } from "./folder-adapter.mjs";
import { createProductionObjectStoreLocalState } from "../object-store-sync-runtime.mjs";
import { ObjectStoreSyncTransport } from "./object-store-sync-transport.mjs";
import { resolveConfiguredStoreRoot } from "./local-object-store.mjs";

export { FOLDER_STORAGE_ADAPTER_ID };

/**
 * @param {Record<string, unknown>} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveFolderObjectStoreRootDir(config, env = process.env) {
  const storage = config.storage;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    throw new StorageError(
      "storage.folder.path is required when storage.backend=folder",
      "invalid_argument",
    );
  }
  const folder = /** @type {Record<string, unknown>} */ (storage).folder;
  const folderPath =
    folder && typeof folder === "object" && !Array.isArray(folder)
      ? String(/** @type {Record<string, unknown>} */ (folder).path ?? "").trim()
      : "";
  const fromEnv = String(env.INFINITECONTEXT_STORAGE_FOLDER_PATH ?? "").trim();
  const chosen = fromEnv || folderPath;
  if (!chosen) {
    throw new StorageError(
      "storage.folder.path is required when storage.backend=folder",
      "invalid_argument",
    );
  }
  if (chosen.startsWith("~/")) {
    return resolveConfiguredStoreRoot(chosen);
  }
  return resolveConfiguredStoreRoot(chosen);
}

/**
 * @param {{
 *   rootDir?: string,
 *   id?: string,
 *   maxObjectBytes?: number,
 *   dek?: Uint8Array,
 *   deviceUuid?: string,
 *   layoutPrefix?: string,
 *   localState?: { load: Function, save: Function },
 *   sync?: { mode?: 'cli' | 'daemon', persist?: boolean, cliStatePath?: string, dbPath?: string },
 *   config?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 */
export async function createFolderObjectStore(options = {}) {
  const config = options.config ?? {};
  const rootDir = path.resolve(
    options.rootDir ?? resolveFolderObjectStoreRootDir(config, options.env),
  );
  const adapter = createFolderStorageAdapter({
    rootDir,
    id: options.id ?? FOLDER_STORAGE_ADAPTER_ID,
    maxObjectBytes: options.maxObjectBytes,
  });
  await adapter.init();
  if (options.dek) {
    const { assertFolderVaultLogsBeginAtSeqZero } = await import("./folder-vault-preflight.mjs");
    await assertFolderVaultLogsBeginAtSeqZero(
      adapter,
      options.dek,
      options.layoutPrefix ?? "accounts/local",
    );
  }
  const persist = options.sync?.persist !== false;
  const localState =
    options.localState ??
    (persist && options.dek && options.deviceUuid
      ? createProductionObjectStoreLocalState({
          mode: options.sync?.mode,
          cliStatePath: options.sync?.cliStatePath,
          dbPath: options.sync?.dbPath,
          env: options.env,
        })
      : null);
  if (localState) {
    const { maybeRebindPersistedObjectStoreState } = await import("../object-store-sync-state-rebind.mjs");
    await maybeRebindPersistedObjectStoreState(localState, config, options.env, {
      rootDir,
      backendId: FOLDER_STORAGE_ADAPTER_ID,
    });
  }
  const transport = new ObjectStoreSyncTransport(
    adapter,
    options.dek && options.deviceUuid && localState
      ? {
          dek: options.dek,
          deviceUuid: options.deviceUuid,
          layoutPrefix: options.layoutPrefix ?? "accounts/local",
          localState,
        }
      : null,
  );
  return {
    rootDir,
    adapter,
    transport,
    localState,
    close: () => adapter.close(),
  };
}
