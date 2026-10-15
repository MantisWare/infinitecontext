import os from "node:os";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { createProductionObjectStoreLocalState } from "../object-store-sync-runtime.mjs";
import { StorageError } from "./errors.mjs";
import { createFilesystemStorageAdapter } from "./filesystem-adapter.mjs";
import { assertLocalObjectStoreRootNotSynced } from "./sync-root-guard.mjs";
import { ObjectStoreSyncTransport } from "./object-store-sync-transport.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

export const LOCAL_OBJECT_STORE_BACKEND_ID = "local-filesystem";

/**
 * @param {string} resolvedPath
 */
function assertAbsoluteStoreRoot(resolvedPath) {
  if (!path.isAbsolute(resolvedPath)) {
    throw new StorageError(
      "Local object store root must be an absolute path (set HOME to an absolute directory)",
      "invalid_argument",
    );
  }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function assertUsableHomeForLocalObjectStore(opts = {}) {
  const env = opts.env ?? process.env;
  const home = String(env.HOME ?? env.USERPROFILE ?? os.homedir()).trim();
  if (!home || !path.isAbsolute(home)) {
    throw new StorageError(
      "HOME must be set to an absolute path to use the default local object store",
      "invalid_argument",
    );
  }
}

/**
 * Default on-disk root for ciphertext objects when no config override is set.
 */
export function defaultLocalObjectStoreRootDir() {
  assertUsableHomeForLocalObjectStore();
  const root = path.resolve(infinitecontextHome(), "object-store");
  assertAbsoluteStoreRoot(root);
  return root;
}

/**
 * @param {string} filePath
 */
function expandHome(filePath) {
  const trimmed = String(filePath ?? "").trim();
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * @param {string} rootPath
 */
export function resolveConfiguredStoreRoot(rootPath) {
  const trimmed = String(rootPath ?? "").trim();
  if (!trimmed) {
    throw new StorageError("Local object store root must not be empty", "invalid_argument");
  }
  if (trimmed.startsWith("~/")) {
    const resolved = path.resolve(expandHome(trimmed));
    assertAbsoluteStoreRoot(resolved);
    return resolved;
  }
  if (!path.isAbsolute(trimmed)) {
    throw new StorageError(
      "Local object store root must be an absolute path (or ~/…)",
      "invalid_argument",
    );
  }
  const resolved = path.resolve(trimmed);
  assertAbsoluteStoreRoot(resolved);
  assertLocalObjectStoreRootNotSynced(resolved);
  return resolved;
}

/**
 * Resolve object store root: env → config.storage.rootDir → default.
 * @param {{ env?: NodeJS.ProcessEnv, config?: Record<string, unknown> }} [opts]
 */
export function resolveLocalObjectStoreRootDir(opts = {}) {
  const env = opts.env ?? process.env;
  const fromEnv = String(env.INFINITECONTEXT_OBJECT_STORE_ROOT ?? "").trim();
  if (fromEnv) {
    return resolveConfiguredStoreRoot(fromEnv);
  }
  const config = opts.config ?? {};
  const storage = config.storage;
  if (storage && typeof storage === "object" && !Array.isArray(storage)) {
    const rootDir = /** @type {Record<string, unknown>} */ (storage).rootDir;
    if (typeof rootDir === "string" && rootDir.trim()) {
      return resolveConfiguredStoreRoot(rootDir.trim());
    }
  }
  const root = defaultLocalObjectStoreRootDir();
  assertLocalObjectStoreRootNotSynced(root);
  return root;
}

/**
 * Open the default local ciphertext object store (filesystem adapter + sealed transport).
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
export async function createLocalObjectStore(options = {}) {
  const rootDir = path.resolve(
    options.rootDir ??
      resolveLocalObjectStoreRootDir({ env: options.env, config: options.config }),
  );
  const adapter = createFilesystemStorageAdapter({
    rootDir,
    id: options.id ?? LOCAL_OBJECT_STORE_BACKEND_ID,
    maxObjectBytes: options.maxObjectBytes,
  });
  await adapter.init();
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
