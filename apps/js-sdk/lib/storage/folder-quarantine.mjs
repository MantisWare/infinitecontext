import fs from "node:fs";
import path from "node:path";

const OBJECTS = "objects";

/**
 * Recursively copy `src` to `dest`, fsync files and directories on the way up.
 * @param {string} src
 * @param {string} dest
 */
function copyTreeWithFsync(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true, mode: st.mode & 0o777 });
    for (const name of fs.readdirSync(src)) {
      copyTreeWithFsync(path.join(src, name), path.join(dest, name));
    }
    const dirFd = fs.openSync(dest, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dest);
  const fd = fs.openSync(dest, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove `target` recursively (best-effort fsync parent).
 * @param {string} target
 */
function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
  const parent = path.dirname(target);
  try {
    const fd = fs.openSync(parent, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Copy a relative path under `objects/` into quarantine, fsync, then remove source.
 * Idempotent when source is already absent.
 *
 * @param {string} rootDir folder adapter root
 * @param {string} relPath path under objects/ (may use OS separators)
 * @param {string} quarantineRoot absolute quarantine directory
 * @returns {boolean} true when something was quarantined
 */
export function quarantineObjectsRelativePath(rootDir, relPath, quarantineRoot) {
  const src = path.join(rootDir, OBJECTS, relPath);
  if (!fs.existsSync(src)) {
    return false;
  }
  const dest = path.join(quarantineRoot, relPath.split(path.sep).join("/"));
  if (fs.existsSync(dest)) {
    return false;
  }
  copyTreeWithFsync(src, dest);
  removeTree(src);
  return true;
}
