import os from "node:os";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { createFilesystemStorageAdapter } from "./filesystem-adapter.mjs";
import { ObjectStoreSyncTransport } from "./object-store-sync-transport.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

export const LOCAL_OBJECT_STORE_BACKEND_ID = "local-filesystem";

/**
 * Default on-disk root for ciphertext objects when no config override is set.
 */
export function defaultLocalObjectStoreRootDir() {
  return path.join(infinitecontextHome(), "object-store");
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
 * Resolve object store root: env → config.storage.rootDir → default.
 * @param {{ env?: NodeJS.ProcessEnv, config?: Record<string, unknown> }} [opts]
 */
export function resolveLocalObjectStoreRootDir(opts = {}) {
  const env = opts.env ?? process.env;
  const fromEnv = String(env.INFINITECONTEXT_OBJECT_STORE_ROOT ?? "").trim();
  if (fromEnv) {
    return path.resolve(expandHome(fromEnv));
  }
  const config = opts.config ?? {};
  const storage = config.storage;
  if (storage && typeof storage === "object" && !Array.isArray(storage)) {
    const rootDir = /** @type {Record<string, unknown>} */ (storage).rootDir;
    if (typeof rootDir === "string" && rootDir.trim()) {
      return path.resolve(expandHome(rootDir.trim()));
    }
  }
  return path.resolve(defaultLocalObjectStoreRootDir());
}

/**
 * Open the default local ciphertext object store (filesystem adapter + sealed transport).
 * @param {{ rootDir?: string, id?: string, maxObjectBytes?: number }} [options]
 */
export async function createLocalObjectStore(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? resolveLocalObjectStoreRootDir());
  const adapter = createFilesystemStorageAdapter({
    rootDir,
    id: options.id ?? LOCAL_OBJECT_STORE_BACKEND_ID,
    maxObjectBytes: options.maxObjectBytes,
  });
  await adapter.init();
  const transport = new ObjectStoreSyncTransport(adapter);
  return {
    rootDir,
    adapter,
    transport,
    close: () => adapter.close(),
  };
}
