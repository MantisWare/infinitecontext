import fs from "node:fs";
import path from "node:path";

import { randomBytes } from "../ic-crypto.mjs";
import { StorageError } from "./errors.mjs";

export const HEARTBEAT_INTERVAL_MS = 2_000;
export const STALE_LOCK_MTIME_MS = 10_000;
export const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
export const ORPHAN_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;

const STEAL_LOCK_SUFFIX = ".steal";

/**
 * @typedef {Object} HeartbeatLockHandle
 * @property {() => void} assertHeld
 * @property {() => void} release
 */

/**
 * @param {string} rootDir
 * @param {string} lockFileName
 * @returns {Promise<HeartbeatLockHandle>}
 */
export async function acquireHeartbeatLock(rootDir, lockFileName) {
  const lockPath = path.join(rootDir, lockFileName);
  const stealPath = `${lockPath}${STEAL_LOCK_SUFFIX}`;
  rejectSymlinkPath(lockPath);
  rejectSymlinkPath(stealPath);

  sweepOrphanArtifacts(rootDir);

  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const token = randomBytes(32).toString("hex");
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, token, 0, Buffer.byteLength(token));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      touchLockMtime(lockPath);
      return createHeldLock(lockPath, token);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        tryStealStaleLockIfNeeded(lockPath, stealPath);
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      throw error;
    }
  }
  throw new StorageError(
    `Timed out waiting for storage secret store lock at ${lockPath}`,
    "lock_timeout",
  );
}

/**
 * @param {string} lockPath
 * @param {string} token
 * @returns {HeartbeatLockHandle}
 */
function createHeldLock(lockPath, token) {
  const touch = () => {
    try {
      touchLockMtime(lockPath);
    } catch {
      // lock may have been stolen; next assertHeld will fail
    }
  };
  const timer = setInterval(touch, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const assertHeld = () => assertLockToken(lockPath, token);

  const release = () => {
    clearInterval(timer);
    try {
      assertHeld();
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error instanceof StorageError && error.code === "lock_compromised") {
        throw error;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new StorageError("Storage secret store lock was compromised", "lock_compromised");
      }
      throw error;
    }
  };

  return { assertHeld, release };
}

/** @param {string} lockPath @param {string} expectedToken */
function assertLockToken(lockPath, expectedToken) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8").trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new StorageError("Storage secret store lock was compromised", "lock_compromised");
    }
    throw error;
  }
  if (raw !== expectedToken) {
    throw new StorageError("Storage secret store lock was compromised", "lock_compromised");
  }
}

/** @param {string} lockPath */
function touchLockMtime(lockPath) {
  const now = new Date();
  fs.utimesSync(lockPath, now, now);
}

/**
 * @param {string} lockPath
 * @returns {boolean}
 */
export function isLockStaleByMtimeForTests(lockPath) {
  return isLockStaleByMtime(lockPath);
}

/** @param {string} lockPath */
function isLockStaleByMtime(lockPath) {
  try {
    const st = fs.statSync(lockPath);
    return Date.now() - st.mtimeMs > STALE_LOCK_MTIME_MS;
  } catch {
    return false;
  }
}

/**
 * @param {string} lockPath
 * @param {string} stealPath
 */
function tryStealStaleLockIfNeeded(lockPath, stealPath) {
  if (!isLockStaleByMtime(lockPath)) {
    return;
  }
  let stealFd;
  try {
    stealFd = fs.openSync(stealPath, "wx", 0o600);
  } catch {
    return;
  }
  try {
    fs.closeSync(stealFd);
  } catch {
    // ignore
  }
  try {
    if (!isLockStaleByMtime(lockPath)) {
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    // ignore — another stealer won
  } finally {
    try {
      fs.unlinkSync(stealPath);
    } catch {
      // ignore
    }
  }
}

/** @param {string} rootDir */
export function sweepOrphanArtifacts(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!shouldSweepEntryName(name)) {
      continue;
    }
    const fullPath = path.join(rootDir, name);
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) {
        continue;
      }
      const st = fs.statSync(fullPath);
      if (now - st.mtimeMs < ORPHAN_SWEEP_MAX_AGE_MS) {
        continue;
      }
      fs.unlinkSync(fullPath);
    } catch {
      // ignore busy or race
    }
  }
}

/** @param {string} name */
function shouldSweepEntryName(name) {
  if (name.endsWith(".steal")) {
    return name.startsWith("storage-secrets.lock");
  }
  if (name.startsWith(".storage-secrets.") && name.includes(".tmp.")) {
    return true;
  }
  if (name.startsWith("storage-secrets.lock.quarantine.")) {
    return true;
  }
  return false;
}

/** @param {string} targetPath */
function rejectSymlinkPath(targetPath) {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new StorageError("Refusing to use symlink for storage secret store path", "invalid_argument");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
