import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_STALE_MS = 60_000;
export const LOCK_PARTIAL_GRACE_MS = 5_000;
const LOCK_ACQUIRE_MS = 10_000;

/** @type {Map<string, NodeJS.Timeout>} */
const heartbeatTimers = new Map();

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {number} min @param {number} max */
function jitterMs(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * @param {string} lockPath
 * @returns {{ pid: number, hostname: string, createdAt: number, heartbeatAt: number } | null}
 */
export function readLockRecord(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed.pid);
    const hostname = String(parsed.hostname ?? "");
    const createdAt = Number(parsed.createdAt);
    const heartbeatAt = Number(parsed.heartbeatAt ?? createdAt);
    if (!Number.isFinite(pid) || !hostname || !Number.isFinite(createdAt)) return null;
    return { pid, hostname, createdAt, heartbeatAt };
  } catch {
    return null;
  }
}

/** @param {number} pid */
function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      if (err.code === "EPERM") return true;
      if (err.code === "ESRCH") return false;
    }
    return false;
  }
}

/**
 * @param {string} lockPath
 * @returns {boolean}
 */
export function isStaleObjectStoreStateLock(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  const record = readLockRecord(lockPath);
  if (!record) {
    try {
      const stat = fs.statSync(lockPath);
      return Date.now() - stat.mtimeMs > LOCK_PARTIAL_GRACE_MS;
    } catch {
      return false;
    }
  }
  const sameHost = record.hostname === os.hostname();
  if (sameHost && isPidAlive(record.pid)) return false;
  if (sameHost && !isPidAlive(record.pid)) return true;
  const age = Date.now() - Math.max(record.heartbeatAt, record.createdAt);
  return age > LOCK_STALE_MS;
}

/** @param {string} lockPath */
export function breakStaleObjectStoreStateLock(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  if (!isStaleObjectStoreStateLock(lockPath)) return;
  const quarantine = `${lockPath}.quarantine.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch {
    return;
  }
  if (!isStaleObjectStoreStateLock(quarantine)) {
    try {
      fs.renameSync(quarantine, lockPath);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    fs.unlinkSync(quarantine);
  } catch {
    /* ignore */
  }
}

/** @param {string} lockPath */
export function startObjectStoreStateLockHeartbeat(lockPath) {
  stopObjectStoreStateLockHeartbeat(lockPath);
  touchObjectStoreStateLock(lockPath);
  const timer = setInterval(() => {
    try {
      touchObjectStoreStateLock(lockPath);
    } catch {
      /* ignore */
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeatTimers.set(lockPath, timer);
}

/** @param {string} lockPath */
export function stopObjectStoreStateLockHeartbeat(lockPath) {
  const timer = heartbeatTimers.get(lockPath);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(lockPath);
  }
}

/**
 * @param {string} lockPath
 * @param {{ timeoutMs?: number }} [options]
 */
export async function acquireObjectStoreStateLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? LOCK_ACQUIRE_MS;
  const started = Date.now();
  fs.mkdirSync(pathDirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    breakStaleObjectStoreStateLock(lockPath);
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      const now = Date.now();
      const payload = {
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: now,
        heartbeatAt: now,
      };
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
      startObjectStoreStateLockHeartbeat(lockPath);
      return fd;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code !== "EEXIST") throw err;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out acquiring object store state lock (${lockPath})`);
    }
    await sleep(jitterMs(25, 120));
  }
}

/** @param {string} lockPath */
export function touchObjectStoreStateLock(lockPath) {
  const record = readLockRecord(lockPath);
  if (!record || record.pid !== process.pid || record.hostname !== os.hostname()) return;
  const next = { ...record, heartbeatAt: Date.now() };
  fs.writeFileSync(lockPath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
}

/** @param {number} fd @param {string} lockPath */
export function releaseObjectStoreStateLock(fd, lockPath) {
  stopObjectStoreStateLockHeartbeat(lockPath);
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    const record = readLockRecord(lockPath);
    if (record?.pid === process.pid && record.hostname === os.hostname()) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* ignore */
  }
}

/** @param {string} dir @param {number} [maxAgeMs] */
export function cleanupOrphanObjectStoreTmpFiles(dir, maxAgeMs = 10 * 60 * 1000) {
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    if (!name.includes(".tmp")) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}

/** @param {string} filePath */
function pathDirname(filePath) {
  return path.dirname(filePath);
}
