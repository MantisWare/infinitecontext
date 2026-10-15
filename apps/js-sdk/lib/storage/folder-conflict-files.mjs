import fs from "node:fs";
import path from "node:path";

import { FS_GEN_HIGH_WATER_BASENAME, FS_GEN_SUFFIX } from "./filesystem-object-file.mjs";
import { readObjectFileNoFollow } from "./filesystem-object-file.mjs";
import { canonicalizeConflictFileName, conflictSegmentToCanonical } from "./folder-conflict-copies.mjs";
import { StorageError } from "./errors.mjs";
import { mapFsError } from "./filesystem-paths.mjs";

/**
 * @param {string} fileName
 * @returns {number | null} canonical generation number for `.icgen` files
 */
export function parseConflictAwareGenerationFileName(fileName) {
  const { canonicalName } = canonicalizeConflictFileName(String(fileName ?? ""));
  if (!canonicalName.endsWith(FS_GEN_SUFFIX)) {
    return null;
  }
  const stem = canonicalName.slice(0, -FS_GEN_SUFFIX.length);
  if (!/^\d{12}$/.test(stem)) {
    return null;
  }
  const gen = Number(stem);
  return Number.isSafeInteger(gen) && gen > 0 ? gen : null;
}

/**
 * @param {string} keyDir
 * @returns {number} 0 when no marker
 */
export function readConflictAwareGenerationHighWater(keyDir) {
  let entries;
  try {
    entries = fs.readdirSync(keyDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw mapFsError(error, keyDir);
  }
  let max = 0;
  for (const name of entries) {
    const canonical = conflictSegmentToCanonical(name) ?? name;
    if (canonical !== FS_GEN_HIGH_WATER_BASENAME) {
      continue;
    }
    const markerPath = path.join(keyDir, name);
    let text;
    try {
      text = fs.readFileSync(markerPath, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      const gen = Number(parsed?.high_water);
      if (Number.isSafeInteger(gen) && gen > 0) {
        max = Math.max(max, gen);
      }
    } catch {
      throw new StorageError("Corrupt generation high-water marker", "corrupt_storage");
    }
  }
  return max;
}

/**
 * @param {string} keyDir
 * @returns {{ gen: number, path: string }[]}
 */
export function listConflictAwareGenerationPaths(keyDir) {
  /** @type {Map<number, string[]>} */
  const byGen = new Map();
  let entries;
  try {
    entries = fs.readdirSync(keyDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw mapFsError(error, keyDir);
  }
  for (const name of entries) {
    const gen = parseConflictAwareGenerationFileName(name);
    if (gen === null) continue;
    const fullPath = path.join(keyDir, name);
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const list = byGen.get(gen) ?? [];
    list.push(fullPath);
    byGen.set(gen, list);
  }
  /** @type {{ gen: number, path: string }[]} */
  const found = [];
  for (const [gen, paths] of byGen.entries()) {
    found.push({ gen, path: paths[0] });
  }
  found.sort((a, b) => b.gen - a.gen);
  return found;
}

/**
 * @param {string[]} paths
 * @param {string} canonicalKeyForAad
 * @param {string} rootDir
 */
/**
 * @param {string} keyDir
 * @param {string} canonicalKeyForAad
 * @param {string} rootDir
 */
export function assertAllConflictAwareGenerationCopiesConsistent(keyDir, canonicalKeyForAad, rootDir) {
  /** @type {Map<number, string[]>} */
  const byGen = new Map();
  let entries;
  try {
    entries = fs.readdirSync(keyDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw mapFsError(error, keyDir);
  }
  for (const name of entries) {
    const gen = parseConflictAwareGenerationFileName(name);
    if (gen === null) continue;
    const fullPath = path.join(keyDir, name);
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const list = byGen.get(gen) ?? [];
    list.push(fullPath);
    byGen.set(gen, list);
  }
  for (const paths of byGen.values()) {
    assertGenerationCopyPathsConsistent(paths, canonicalKeyForAad, rootDir);
  }
}

export function assertGenerationCopyPathsConsistent(paths, canonicalKeyForAad, rootDir) {
  if (paths.length <= 1) return;
  /** @type {string | null} */
  let digest = null;
  let readable = 0;
  let unreadable = 0;
  for (const filePath of paths) {
    /** @type {{ header: import("./filesystem-object-file.mjs").StoredObjectHeader, body: Uint8Array } | null} */
    let decoded = null;
    try {
      decoded = readObjectFileNoFollow(filePath, canonicalKeyForAad, rootDir);
    } catch (error) {
      if (error instanceof StorageError && error.code === "corrupt_storage") {
        unreadable += 1;
        continue;
      }
      throw error;
    }
    if (!decoded) {
      unreadable += 1;
      continue;
    }
    readable += 1;
    const tag = `${decoded.header.etag}:${decoded.header.size}`;
    if (digest === null) {
      digest = tag;
    } else if (digest !== tag) {
      throw new StorageError(
        `Conflicting sync copies for ${canonicalKeyForAad} at ${path.basename(filePath)}`,
        "storage_fork",
      );
    }
  }
  if (readable > 0 && unreadable > 0) {
    throw new StorageError(
      `Undecryptable or foreign-key conflict copy for ${canonicalKeyForAad}`,
      "corrupt_storage",
    );
  }
  if (readable === 0 && unreadable > 0) {
    throw new StorageError(
      `Undecryptable or foreign-key conflict copy for ${canonicalKeyForAad}`,
      "corrupt_storage",
    );
  }
}

/**
 * @param {string} keyDir
 * @param {string} canonicalKeyForAad
 * @param {string} rootDir
 * @param {number} highWater
 */
/**
 * @param {string} keyDir
 * @param {string} canonicalKeyForAad
 * @param {string} rootDir
 * @param {{ gen: number, path: string }[]} filtered
 */
function assertForkCheckAcrossGenerations(keyDir, canonicalKeyForAad, rootDir, filtered) {
  /** @type {Map<number, string[]>} */
  const byGen = new Map();
  for (const row of filtered) {
    const list = byGen.get(row.gen) ?? [];
    list.push(row.path);
    byGen.set(row.gen, list);
  }
  for (const gen of [...byGen.keys()].sort((a, b) => b - a)) {
    const sameGenPaths = [];
    for (const name of fs.readdirSync(keyDir)) {
      if (parseConflictAwareGenerationFileName(name) === gen) {
        sameGenPaths.push(path.join(keyDir, name));
      }
    }
    assertGenerationCopyPathsConsistent(sameGenPaths, canonicalKeyForAad, rootDir);
  }
}

export function listNonStaleConflictAwareGenerationPaths(keyDir, canonicalKeyForAad, rootDir, highWater) {
  const paths = listConflictAwareGenerationPaths(keyDir);
  const filtered = highWater > 0 ? paths.filter((row) => row.gen >= highWater) : paths;
  if (filtered.length > 0) {
    assertForkCheckAcrossGenerations(keyDir, canonicalKeyForAad, rootDir, filtered);
  }
  return filtered;
}
