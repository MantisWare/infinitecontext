import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageError } from "./errors.mjs";

/** @type {boolean | null} */
let cachedLinkSupported = null;

/**
 * Hard links for CAS commits require filesystem link support (not all network shares).
 * @param {string} [probeDir]
 * @returns {boolean}
 */
export function isHardLinkCommitSupported(probeDir) {
  if (cachedLinkSupported !== null) {
    return cachedLinkSupported;
  }
  const dir = probeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ic-ss-link-probe-"));
  const src = path.join(dir, "link-probe-src");
  const dst = path.join(dir, "link-probe-dst");
  let ownedDir = !probeDir;
  try {
    fs.writeFileSync(src, "x", { mode: 0o600 });
    fs.linkSync(src, dst);
    fs.unlinkSync(dst);
    fs.unlinkSync(src);
    cachedLinkSupported = true;
  } catch {
    cachedLinkSupported = false;
  } finally {
    if (ownedDir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  return cachedLinkSupported;
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
