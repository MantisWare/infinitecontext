import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageError } from "./errors.mjs";

/** @type {Map<string, boolean>} */
const linkProbeCache = new Map();

/** Clears per-directory link probe cache (tests only). */
export function resetHardLinkProbeCacheForTests() {
  linkProbeCache.clear();
}

/**
 * Hard links for CAS commits require filesystem link support (not all network shares).
 * @param {string} [probeDir]
 * @returns {boolean}
 */
export function isHardLinkCommitSupported(probeDir) {
  const dir = probeDir ? path.resolve(probeDir) : fs.mkdtempSync(path.join(os.tmpdir(), "ic-ss-link-probe-"));
  const cacheKey = path.resolve(dir);
  if (linkProbeCache.has(cacheKey)) {
    return linkProbeCache.get(cacheKey) ?? false;
  }
  const supported = probeHardLinkInDirectory(dir, !probeDir);
  linkProbeCache.set(cacheKey, supported);
  return supported;
}

/**
 * @param {string} dir
 * @param {boolean} removeDirAfter
 */
function probeHardLinkInDirectory(dir, removeDirAfter) {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const src = path.join(dir, `.ic-link-probe-src.${unique}`);
  const dst = path.join(dir, `.ic-link-probe-dst.${unique}`);
  /** @type {string[]} */
  const created = [];
  try {
    fs.writeFileSync(src, "x", { mode: 0o600 });
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
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  } catch {
    return false;
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

/** @param {string} rootDir */
export function assertHardLinkCommitSupported(rootDir) {
  if (!isHardLinkCommitSupported(rootDir)) {
    throw new StorageError(
      "This filesystem does not support hard-link CAS commits for the encrypted secret store. " +
        "Use a local disk (ext4, APFS, NTFS) or INFINITECONTEXT_SECRET_STORE=keyring.",
      "not_supported",
    );
  }
}
