import fs from "node:fs";
import path from "node:path";

const OBJECTS = "objects";

/**
 * @param {string} a
 * @param {string} b
 */
function treesByteIdentical(a, b) {
  const stA = fs.lstatSync(a);
  const stB = fs.lstatSync(b);
  if (stA.isDirectory() !== stB.isDirectory()) return false;
  if (stA.isFile()) {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  }
  const namesA = fs.readdirSync(a).sort();
  const namesB = fs.readdirSync(b).sort();
  if (namesA.length !== namesB.length) return false;
  for (let i = 0; i < namesA.length; i += 1) {
    if (namesA[i] !== namesB[i]) return false;
    if (!treesByteIdentical(path.join(a, namesA[i]), path.join(b, namesB[i]))) return false;
  }
  return true;
}

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
 * @param {string} dest
 */
function uniquifyQuarantineDest(dest) {
  const stamp = `${Date.now()}-${process.pid}`;
  const leaf = path.basename(dest);
  return path.join(path.dirname(dest), `${leaf}.quarantine-${stamp}`);
}

/**
 * @param {string} quarantineRoot
 * @param {string} src
 * @returns {string | null}
 */
function findIdenticalTreeUnderQuarantine(quarantineRoot, src) {
  if (!fs.existsSync(quarantineRoot)) return null;
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (treesByteIdentical(src, full)) return full;
      const nested = walk(full);
      if (nested) return nested;
    }
    return null;
  };
  return walk(quarantineRoot);
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
  const normalizedRel = relPath.split(path.sep).join("/");
  const existing = findIdenticalTreeUnderQuarantine(quarantineRoot, src);
  if (existing) {
    removeTree(src);
    return true;
  }
  let dest = path.join(quarantineRoot, normalizedRel);
  if (fs.existsSync(dest)) {
    if (treesByteIdentical(src, dest)) {
      removeTree(src);
      return true;
    }
    dest = uniquifyQuarantineDest(dest);
  }
  copyTreeWithFsync(src, dest);
  removeTree(src);
  return true;
}
