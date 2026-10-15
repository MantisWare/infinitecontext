import path from "node:path";

import { StorageError } from "./errors.mjs";
import { layoutRootPath } from "./layout.mjs";
import { physicalKeyDirsForCanonicalKey, scanCanonicalKeysFromObjectsTree } from "./folder-on-disk-scan.mjs";
import { assertAllConflictAwareGenerationCopiesConsistent } from "./folder-conflict-files.mjs";
import { keyDirIsPlaceholderOnlyEvicted } from "./folder-evicted-key-dir.mjs";
import { findEvictedPlaceholderFileInKeyDir } from "./folder-icloud-placeholder.mjs";

/**
 * @param {string} keyDir
 * @param {string} canonicalKey
 */
function assertKeyDirNoEvictedPlaceholder(keyDir, canonicalKey) {
  if (keyDirIsPlaceholderOnlyEvicted(keyDir)) {
    throw new StorageError(
      `Evicted iCloud placeholder for storage object ${canonicalKey}`,
      "evicted_placeholder",
    );
  }
  const evicted = findEvictedPlaceholderFileInKeyDir(keyDir);
  if (evicted) {
    throw new StorageError(
      `Evicted iCloud placeholder for storage object ${canonicalKey}`,
      "evicted_placeholder",
    );
  }
}

/**
 * @param {string} rootDir
 * @param {string} key
 */
function assertObjectKeyFileCopiesClean(rootDir, key) {
  for (const row of physicalKeyDirsForCanonicalKey(rootDir, key)) {
    assertKeyDirNoEvictedPlaceholder(row.keyDir, row.canonicalKey);
    assertAllConflictAwareGenerationCopiesConsistent(row.keyDir, row.canonicalKey, rootDir);
  }
}

/**
 * @param {string} lowerKey
 * @param {string | null} layoutPrefix
 */
/**
 * @param {string} lowerKey
 * @param {string | null} layoutPrefix
 * @param {{ includeManifest?: boolean }} [scopeOptions]
 */
function keyMatchesPreflightScope(lowerKey, layoutPrefix, scopeOptions = {}) {
  if (layoutPrefix) {
    const devicesPrefix = `${layoutRootPath(layoutPrefix)}/devices/`.toLowerCase();
    const logPrefix = `${layoutRootPath(layoutPrefix)}/log/`.toLowerCase();
    const manifestKey = `${layoutRootPath(layoutPrefix)}/manifest.json.enc`.toLowerCase();
    if (lowerKey.startsWith(devicesPrefix) || lowerKey.startsWith(logPrefix)) return true;
    if (scopeOptions.includeManifest && lowerKey === manifestKey) return true;
    return false;
  }
  if (lowerKey.includes("/ic-v1/devices/") || lowerKey.includes("/ic-v1/log/")) return true;
  if (scopeOptions.includeManifest && lowerKey.endsWith("/ic-v1/manifest.json.enc")) return true;
  return false;
}

/**
 * Detect file-level `.icgen` conflict copies on log segments and devices/ before chain verification.
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {string} [layoutPrefix]
 * @param {{ includeManifest?: boolean }} [options]
 */
export async function assertFolderObjectFileCopiesClean(adapter, layoutPrefix = null, options = {}) {
  const folder = /** @type {{ rootDir?: string }} */ (adapter);
  const rootDir = folder.rootDir;
  if (!rootDir) return;
  const objectsRoot = path.join(rootDir, "objects");
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    const lower = key.toLowerCase();
    if (!keyMatchesPreflightScope(lower, layoutPrefix, options)) continue;
    assertObjectKeyFileCopiesClean(rootDir, key);
  }
}

export { assertObjectKeyFileCopiesClean };

/**
 * Folder-level conflict dirs (log + devices/) via adapter candidate resolution.
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {string} [layoutPrefix]
 */
export async function assertFolderCopyFolderDirsClean(adapter, layoutPrefix = null) {
  const conflictAware = /** @type {{ rootDir?: string, listConflictGetCandidates?: (k: string) => Promise<unknown[]> }} */ (
    adapter
  );
  if (!conflictAware.rootDir || typeof conflictAware.listConflictGetCandidates !== "function") {
    return;
  }
  const rootDir = conflictAware.rootDir;
  const objectsRoot = path.join(rootDir, "objects");
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    const lower = key.toLowerCase();
    if (!keyMatchesPreflightScope(lower, layoutPrefix)) continue;
    await conflictAware.listConflictGetCandidates.call(adapter, key);
  }
}
