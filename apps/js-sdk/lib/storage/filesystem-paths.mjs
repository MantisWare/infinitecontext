import fs from "node:fs";
import path from "node:path";

import { StorageError } from "./errors.mjs";
import { assertCanonicalStorageObjectKey } from "./filesystem-keys.mjs";

/**
 * @param {string} rootDir
 * @param {string} key
 */
export function resolveObjectFilePath(rootDir, key) {
  const canonical = assertCanonicalStorageObjectKey(key);
  const root = path.resolve(rootDir);
  const segments = canonical.split("/");
  let cursor = root;
  for (const segment of segments) {
    rejectSymlinkPath(cursor);
    cursor = path.join(cursor, segment);
  }
  rejectSymlinkPath(cursor);
  if (cursor !== root && !cursor.startsWith(`${root}${path.sep}`)) {
    throw new StorageError("Storage object key escapes the store root", "invalid_argument");
  }
  return { canonical, objectPath: cursor };
}

/**
 * @param {string} rootDir
 */
export function rejectSymlinkInStoreRoot(rootDir) {
  const root = path.resolve(rootDir);
  rejectSymlinkPath(root);
}

/**
 * @param {string} targetPath
 */
export function rejectSymlinkPath(targetPath) {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new StorageError(`Symlinks are not allowed in the storage path (${targetPath})`, "invalid_argument");
    }
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw mapFsError(error, targetPath);
  }
}

/**
 * @param {unknown} error
 * @param {string} targetPath
 */
export function mapFsError(error, targetPath) {
  if (error instanceof StorageError) {
    return error;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (code === "ENOENT") {
      return new StorageError(`Storage path not found (${targetPath})`, "not_found");
    }
    if (code === "EACCES" || code === "EPERM") {
      return new StorageError(`Permission denied (${targetPath})`, "permission_denied");
    }
    if (code === "ELOOP") {
      return new StorageError(`Symlinks are not allowed (${targetPath})`, "invalid_argument");
    }
  }
  return new StorageError(
    error instanceof Error ? error.message : "Filesystem storage operation failed",
    "storage_io_error",
  );
}
