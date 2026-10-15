import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageError } from "./errors.mjs";

/**
 * @param {string} rootDir
 * @returns {string}
 */
export function resolveSyncedRootRealpath(rootDir) {
  const resolved = path.resolve(String(rootDir ?? ""));
  try {
    return fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * @param {string} normalized absolute path
 * @param {string} homeReal realpath of $HOME
 */
function isUnderHomeSyncAnchor(normalized, homeReal) {
  const lower = normalized.toLowerCase();
  const homeLower = homeReal.toLowerCase();
  if (!lower.startsWith(homeLower + path.sep) && lower !== homeLower) {
    return false;
  }
  const rel = path.relative(homeReal, normalized);
  const parts = rel.split(path.sep).filter(Boolean);
  if (!parts.length) return false;
  const first = parts[0].toLowerCase();
  if (first === "library") {
    const second = (parts[1] ?? "").toLowerCase();
    if (second === "mobile documents") return true;
    if (second === "cloudstorage") return true;
  }
  if (first.startsWith("dropbox")) return true;
  if (first === "dropbox (personal)" || first.startsWith("dropbox (")) return true;
  if (first.startsWith("onedrive")) return true;
  if (first.startsWith("google drive")) return true;
  return false;
}

/**
 * @param {string} normalized absolute path
 */
function isCloudStorageProviderRoot(normalized) {
  const lower = normalized.toLowerCase();
  const cloudStorage = `${path.sep}library${path.sep}cloudstorage${path.sep}`;
  const idx = lower.indexOf(cloudStorage);
  if (idx < 0) return false;
  const tail = normalized.slice(idx + cloudStorage.length);
  const provider = tail.split(path.sep)[0] ?? "";
  const p = provider.toLowerCase();
  return (
    p.startsWith("onedrive-") ||
    p.startsWith("googledrive-") ||
    p.startsWith("google drive-") ||
    p.startsWith("dropbox")
  );
}

/**
 * @param {string} normalized absolute path
 */
function hasDropboxRootMarker(normalized) {
  try {
    return fs.existsSync(path.join(normalized, ".dropbox"));
  } catch {
    return false;
  }
}

/**
 * Walk ancestors for provider markers (e.g. /mnt/Dropbox/.dropbox).
 * @param {string} normalized absolute path
 */
function ancestorHasDropboxMarker(normalized) {
  let cursor = normalized;
  for (;;) {
    if (hasDropboxRootMarker(cursor)) {
      return true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

/**
 * @param {string} normalized absolute path
 */
function isGoogleDriveVolume(normalized) {
  const lower = normalized.toLowerCase();
  return lower.startsWith(`${path.sep}volumes${path.sep}googledrive`);
}

/**
 * @param {string} rootDir absolute resolved realpath
 */
export function isKnownSyncedFolderRoot(rootDir) {
  const normalized = resolveSyncedRootRealpath(rootDir);
  let homeReal;
  try {
    homeReal = resolveSyncedRootRealpath(os.homedir());
  } catch {
    homeReal = path.resolve(os.homedir());
  }

  if (hasDropboxRootMarker(normalized) || ancestorHasDropboxMarker(normalized)) {
    return true;
  }
  if (isGoogleDriveVolume(normalized)) {
    return true;
  }
  if (isCloudStorageProviderRoot(normalized)) {
    return true;
  }
  if (isUnderHomeSyncAnchor(normalized, homeReal)) {
    return true;
  }
  if (normalized === homeReal) {
    return false;
  }
  return false;
}

/**
 * @param {string} rootDir
 */
export function assertLocalObjectStoreRootNotSynced(rootDir) {
  if (isKnownSyncedFolderRoot(rootDir)) {
    throw new StorageError(
      "This path looks like a desktop-sync folder (iCloud/Dropbox/Google Drive/OneDrive/CloudStorage). " +
        "Use storage.backend=folder with storage.folder.path instead of backend=local. " +
        "On Windows, drive-letter paths such as D:\\OneDrive are detected best-effort only.",
      "invalid_argument",
    );
  }
}
