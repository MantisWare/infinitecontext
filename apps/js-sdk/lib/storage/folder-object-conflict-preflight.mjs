import path from "node:path";

import { StorageError } from "./errors.mjs";
import { layoutRootPath } from "./layout.mjs";
import { physicalKeyDirsForCanonicalKey, scanCanonicalKeysFromObjectsTree } from "./folder-on-disk-scan.mjs";
import { assertAllConflictAwareGenerationCopiesConsistent } from "./folder-conflict-files.mjs";
import { findEvictedPlaceholderFileInKeyDir } from "./folder-icloud-placeholder.mjs";

/**
 * @param {string} keyDir
 * @param {string} canonicalKey
 */
function assertKeyDirNoEvictedPlaceholder(keyDir, canonicalKey) {
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
function keyMatchesPreflightScope(lowerKey, layoutPrefix) {
  if (layoutPrefix) {
    const devicesPrefix = `${layoutRootPath(layoutPrefix)}/devices/`.toLowerCase();
    const logPrefix = `${layoutRootPath(layoutPrefix)}/log/`.toLowerCase();
    return lowerKey.startsWith(devicesPrefix) || lowerKey.startsWith(logPrefix);
  }
  return lowerKey.includes("/ic-v1/devices/") || lowerKey.includes("/ic-v1/log/");
}

/**
 * Detect file-level `.icgen` conflict copies on log segments and devices/ before chain verification.
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {string} [layoutPrefix]
 */
export async function assertFolderObjectFileCopiesClean(adapter, layoutPrefix = null) {
  const folder = /** @type {{ rootDir?: string }} */ (adapter);
  const rootDir = folder.rootDir;
  if (!rootDir) return;
  const objectsRoot = path.join(rootDir, "objects");
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    const lower = key.toLowerCase();
    if (!keyMatchesPreflightScope(lower, layoutPrefix)) continue;
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
