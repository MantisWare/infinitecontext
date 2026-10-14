import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageError } from "./errors.mjs";
import { ensurePrivateDir } from "./secret-store-private-dir.mjs";

/** @type {Map<string, boolean>} */
const linkProbeCache = new Map();

const PROBE_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;
const PROBE_SRC_PREFIX = ".ic-link-probe-src.";
const PROBE_DST_PREFIX = ".ic-link-probe-dst.";

/** Clears per-directory link probe cache (tests only). */
export function resetHardLinkProbeCacheForTests() {
  linkProbeCache.clear();
}

/**
 * Hard links for CAS commits require filesystem link support (not all network shares).
 * Caller should ensure {@link ensurePrivateDir} first for store roots (see {@link assertHardLinkCommitSupported}).
 * @param {string} probeDir
 * @returns {boolean}
 */
export function isHardLinkCommitSupported(probeDir) {
  const dir = path.resolve(probeDir);
  if (linkProbeCache.has(dir)) {
    return linkProbeCache.get(dir) ?? false;
  }
  let supported;
  try {
    supported = probeHardLinkInDirectory(dir, false);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw error;
  }
  linkProbeCache.set(dir, supported);
  return supported;
}

/**
 * @param {string} dir
 * @param {boolean} removeDirAfter
 * @returns {boolean}
 */
function probeHardLinkInDirectory(dir, removeDirAfter) {
  sweepOldLinkProbeArtifacts(dir);
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const src = path.join(dir, `${PROBE_SRC_PREFIX}${unique}`);
  const dst = path.join(dir, `${PROBE_DST_PREFIX}${unique}`);
  /** @type {string[]} */
  const created = [];
  try {
    try {
      fs.writeFileSync(src, "x", { mode: 0o600 });
    } catch (error) {
      throw mapProbeFsError(error, dir);
    }
    created.push(src);
    try {
      fs.linkSync(src, dst);
      created.push(dst);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        const altDst = `${dst}.retry`;
        try {
          fs.linkSync(src, altDst);
          created.push(altDst);
        } catch (retryError) {
          if (retryError && typeof retryError === "object" && "code" in retryError) {
            const code = retryError.code;
            if (code === "ENOENT" || code === "EACCES") {
              throw mapProbeFsError(retryError, dir);
            }
          }
          return false;
        }
      } else if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (code === "ENOENT" || code === "EACCES") {
          throw mapProbeFsError(error, dir);
        }
        return false;
      } else {
        return false;
      }
    }
    return true;
  } finally {
    for (const filePath of created) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    if (removeDirAfter) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * @param {unknown} error
 * @param {string} dir
 */
function mapProbeFsError(error, dir) {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT") {
      return new StorageError(
        `Storage secret store directory is missing (${dir})`,
        "store_directory_missing",
      );
    }
    if (error.code === "EACCES") {
      return new StorageError(
        `Permission denied accessing storage secret store directory (${dir})`,
        "permission_denied",
      );
    }
  }
  return error;
}

/** @param {string} rootDir */
function sweepOldLinkProbeArtifacts(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(PROBE_SRC_PREFIX) && !name.startsWith(PROBE_DST_PREFIX)) {
      continue;
    }
    const fullPath = path.join(rootDir, name);
    try {
      const st = fs.statSync(fullPath);
      if (now - st.mtimeMs < PROBE_SWEEP_MAX_AGE_MS) {
        continue;
      }
      fs.unlinkSync(fullPath);
    } catch {
      // ignore
    }
  }
}

/** @param {string} rootDir */
export function assertHardLinkCommitSupported(rootDir) {
  ensurePrivateDir(rootDir);
  sweepOldLinkProbeArtifacts(rootDir);
  if (!isHardLinkCommitSupported(rootDir)) {
    throw new StorageError(
      "This filesystem does not support hard-link CAS commits for the encrypted secret store. " +
        "Use a local disk (ext4, APFS, NTFS) or INFINITECONTEXT_SECRET_STORE=keyring.",
      "not_supported",
    );
  }
}
