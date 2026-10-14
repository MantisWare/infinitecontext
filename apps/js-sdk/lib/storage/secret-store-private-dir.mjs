import fs from "node:fs";

import { StorageError } from "./errors.mjs";

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
  try {
    fs.chmodSync(rootDir, 0o700);
  } catch (error) {
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
