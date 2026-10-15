import path from "node:path";

import { layoutRootPath } from "./layout.mjs";
import { physicalKeyDirsForCanonicalKey, scanCanonicalKeysFromObjectsTree } from "./folder-on-disk-scan.mjs";
import {
  listNonStaleConflictAwareGenerationPaths,
  readConflictAwareGenerationHighWater,
} from "./folder-conflict-files.mjs";

/**
 * Detect file-level `.icgen` conflict copies on log segments before chain verification.
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 */
export async function assertFolderLogSegmentFileCopiesClean(adapter, layoutPrefix = null) {
  const folder = /** @type {{ rootDir?: string }} */ (adapter);
  const rootDir = folder.rootDir;
  if (!rootDir) return;
  const logPrefix = layoutPrefix ? `${layoutRootPath(layoutPrefix)}/log/`.toLowerCase() : null;
  const objectsRoot = path.join(rootDir, "objects");
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    const lower = key.toLowerCase();
    if (logPrefix) {
      if (!lower.startsWith(logPrefix)) continue;
    } else if (!lower.includes("/ic-v1/log/")) {
      continue;
    }
    for (const row of physicalKeyDirsForCanonicalKey(rootDir, key)) {
      const highWater = readConflictAwareGenerationHighWater(row.keyDir);
      listNonStaleConflictAwareGenerationPaths(row.keyDir, row.canonicalKey, rootDir, highWater);
    }
  }
}
