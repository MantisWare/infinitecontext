import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertRealpathUnderRoot } from "./filesystem-object-file.mjs";
import { mapFsError, rejectSymlinkPath } from "./filesystem-paths.mjs";
import { StorageError } from "./errors.mjs";

export const MIGRATION_DEST_SYMLINK_OR_ESCAPE_MESSAGE =
  "Migration destination contains a symlink or a path outside the destination folder; use an empty folder or `storage migrate --reset`";

/**
 * @param {string} destRoot
 * @param {string} [message]
 */
function throwMigrationDestPathBlocked(message = MIGRATION_DEST_SYMLINK_OR_ESCAPE_MESSAGE) {
  throw new StorageError(message, "invalid_argument");
}

/**
 * @param {string} destRoot
 * @param {string} targetPath absolute or relative path under destRoot
 */
export function assertMigrationDestWriteTargetSafe(destRoot, targetPath) {
  const root = path.resolve(destRoot);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throwMigrationDestPathBlocked();
  }
  rejectSymlinkPath(root);
  const rel = path.relative(root, target);
  if (!rel || rel === ".") {
    return;
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throwMigrationDestPathBlocked();
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        break;
      }
      throw mapFsError(error, cursor);
    }
    if (i === parts.length - 1 || fs.existsSync(cursor)) {
      try {
        assertRealpathUnderRoot(cursor, root);
      } catch (error) {
        if (error instanceof StorageError) {
          throwMigrationDestPathBlocked();
        }
        throw error;
      }
    }
  }
}

/**
 * @param {string} destRoot
 * @param {string} absFilePath
 */
export function migrationDestFileFingerprint(destRoot, absFilePath) {
  assertMigrationDestWriteTargetSafe(destRoot, absFilePath);
  let fd;
  try {
    fd = fs.openSync(absFilePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw mapFsError(error, absFilePath);
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isSymbolicLink()) {
      throwMigrationDestPathBlocked();
    }
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return {
      size: buf.length,
      hash: crypto.createHash("sha256").update(buf).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Fail closed on any symlink or realpath escape under `destRoot/objects/`.
 *
 * @param {string} destRoot
 */
export function assertMigrationDestinationTreeSafe(destRoot) {
  const root = path.resolve(destRoot);
  rejectSymlinkPath(root);
  const objects = path.join(root, "objects");
  if (!fs.existsSync(objects)) {
    return;
  }
  /** @param {string} cursor */
  const walk = (cursor) => {
    let st;
    try {
      st = fs.lstatSync(cursor);
    } catch (error) {
      throw mapFsError(error, cursor);
    }
    if (st.isSymbolicLink()) {
      throwMigrationDestPathBlocked();
    }
    try {
      assertRealpathUnderRoot(cursor, root);
    } catch {
      throwMigrationDestPathBlocked();
    }
    if (!st.isDirectory()) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(cursor);
    } catch (error) {
      throw mapFsError(error, cursor);
    }
    for (const name of entries) {
      walk(path.join(cursor, name));
    }
  };
  walk(objects);
}
