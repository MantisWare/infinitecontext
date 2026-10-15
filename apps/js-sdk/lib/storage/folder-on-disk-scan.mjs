import fs from "node:fs";
import path from "node:path";

import { FS_GEN_SUFFIX } from "./filesystem-object-file.mjs";
import { canonicalizeConflictStorageKey, conflictSegmentToCanonical } from "./folder-conflict-copies.mjs";
import { keyDirIsPlaceholderOnlyEvicted } from "./folder-evicted-key-dir.mjs";
import { mapFsError } from "./filesystem-paths.mjs";

const OBJECTS_SUBDIR = "objects";

/**
 * @param {string} dir
 */
function directoryHasObjectGenerations(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(FS_GEN_SUFFIX)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * @param {string} objectsRoot
 * @param {string} [prefix]
 * @returns {Set<string>} canonical API keys
 */
export function scanCanonicalKeysFromObjectsTree(objectsRoot, prefix = "") {
  const normalizedPrefix = String(prefix ?? "").replace(/^\/+|\/+$/g, "");
  /** @type {Set<string>} */
  const keys = new Set();
  const root = path.join(objectsRoot, ...normalizedPrefix.split("/").filter(Boolean));
  const walk = (cursor, relParts) => {
    let entries;
    try {
      entries = fs.readdirSync(cursor);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw mapFsError(error, cursor);
    }
    if (directoryHasObjectGenerations(cursor) || keyDirIsPlaceholderOnlyEvicted(cursor)) {
      const rawKey = relParts.map((seg) => String(seg).toLowerCase()).join("/");
      keys.add(canonicalizeConflictStorageKey(rawKey));
      return;
    }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const next = path.join(cursor, name);
      let st;
      try {
        st = fs.lstatSync(next);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      walk(next, [...relParts, name]);
    }
  };
  if (fs.existsSync(root)) {
    walk(root, normalizedPrefix ? normalizedPrefix.split("/") : []);
  } else if (!normalizedPrefix) {
    walk(objectsRoot, []);
  }
  return keys;
}

/**
 * @param {string} rootDir adapter root
 * @param {string} canonicalKey
 * @returns {{ keyDir: string, canonicalKey: string }[]}
 */
export function physicalKeyDirsForCanonicalKey(rootDir, canonicalKey) {
  const canonical = canonicalizeConflictStorageKey(canonicalKey);
  const parts = canonical.split("/");
  const leaf = parts[parts.length - 1];
  const objectsRoot = path.join(path.resolve(rootDir), OBJECTS_SUBDIR);
  const parentRel = parts.slice(0, -1);
  const parentDir = path.join(objectsRoot, ...parentRel);
  /** @type {{ keyDir: string, canonicalKey: string }[]} */
  const out = [];
  const canonicalDir = path.join(parentDir, leaf);
  if (fs.existsSync(canonicalDir)) {
    out.push({ keyDir: canonicalDir, canonicalKey: canonical });
  }
  try {
    for (const name of fs.readdirSync(parentDir)) {
      const mapped = conflictSegmentToCanonical(name);
      if (mapped === leaf && name !== leaf) {
        out.push({ keyDir: path.join(parentDir, name), canonicalKey: canonical });
      }
    }
  } catch {
    /* parent may not exist yet */
  }
  return out;
}
