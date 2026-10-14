import fs from "node:fs";

import { StorageError } from "./errors.mjs";

/** @type {typeof fs.chmodSync | null} */
let chmodSyncImplForTests = null;

/** @param {typeof fs.chmodSync | null} fn */
export function setChmodSyncImplForTests(fn) {
  chmodSyncImplForTests = fn;
}

const CHMOD_IGNORE_CODES = new Set(["EPERM", "EACCES", "ENOTSUP", "EROFS"]);

/**
 * Creates the store directory at mode 0700, or chmods an existing directory to 0700.
 * @param {string} rootDir
 */
export function ensurePrivateDir(rootDir) {
  try {
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw mapEnsureDirError(error, rootDir);
  }
  tryChmod0700(rootDir);
}

/**
 * @param {string} rootDir
 */
function tryChmod0700(rootDir) {
  const chmodSync = chmodSyncImplForTests ?? fs.chmodSync;
  try {
    chmodSync(rootDir, 0o700);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && CHMOD_IGNORE_CODES.has(String(error.code))) {
      if (process.env.INFINITECONTEXT_DEBUG) {
        console.debug(`ensurePrivateDir: chmod 0700 ignored (${String(error.code)}) for ${rootDir}`);
      }
      return;
    }
    throw mapEnsureDirError(error, rootDir);
  }
}

/**
 * @param {unknown} error
 * @param {string} rootDir
 */
function mapEnsureDirError(error, rootDir) {
  if (error instanceof StorageError) {
    return error;
  }
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT") {
      return new StorageError(
        `Storage secret store directory is missing (${rootDir})`,
        "store_directory_missing",
      );
    }
    if (error.code === "EACCES") {
      return new StorageError(
        `Permission denied accessing storage secret store directory (${rootDir})`,
        "permission_denied",
      );
    }
  }
  return error;
}
