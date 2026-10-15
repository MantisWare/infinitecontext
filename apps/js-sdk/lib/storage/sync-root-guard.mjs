import path from "node:path";

import { StorageError } from "./errors.mjs";

/** Substrings that indicate a desktop-sync folder (use storage.backend=folder). */
const SYNCED_ROOT_MARKERS = [
  `${path.sep}Mobile Documents${path.sep}com~apple~CloudDocs`,
  `${path.sep}CloudDocs${path.sep}`,
  `${path.sep}Dropbox${path.sep}`,
  `${path.sep}Google Drive${path.sep}`,
  `${path.sep}OneDrive${path.sep}`,
  `${path.sep}Nextcloud${path.sep}`,
  `${path.sep}ownCloud${path.sep}`,
];

/**
 * @param {string} rootDir absolute resolved path
 */
export function isKnownSyncedFolderRoot(rootDir) {
  const normalized = path.resolve(rootDir);
  const lower = normalized.toLowerCase();
  for (const marker of SYNCED_ROOT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return true;
  }
  return false;
}

/**
 * @param {string} rootDir
 */
export function assertLocalObjectStoreRootNotSynced(rootDir) {
  if (isKnownSyncedFolderRoot(rootDir)) {
    throw new StorageError(
      "This path looks like a desktop-sync folder (iCloud/Dropbox/Google Drive/OneDrive/Nextcloud). " +
        "Use storage.backend=folder with storage.folder.path instead of backend=local.",
      "invalid_argument",
    );
  }
}
