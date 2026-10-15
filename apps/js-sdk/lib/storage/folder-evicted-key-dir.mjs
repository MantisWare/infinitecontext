import fs from "node:fs";

import { FS_GEN_HIGH_WATER_BASENAME, FS_GEN_SUFFIX } from "./filesystem-object-file.mjs";
import { findEvictedPlaceholderFileInKeyDir } from "./folder-icloud-placeholder.mjs";

/**
 * iCloud may evict all `.icgen` bodies and leave only a `.*.icloud` stub in the key dir.
 *
 * @param {string} keyDir
 */
export function keyDirIsPlaceholderOnlyEvicted(keyDir) {
  let entries;
  try {
    entries = fs.readdirSync(keyDir).filter((n) => n !== "." && n !== "..");
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  let sawPlaceholder = false;
  for (const name of entries) {
    if (name === FS_GEN_HIGH_WATER_BASENAME) {
      continue;
    }
    if (name.endsWith(FS_GEN_SUFFIX)) {
      return false;
    }
    if (name.startsWith(".") && name.endsWith(".icloud")) {
      sawPlaceholder = true;
      continue;
    }
    return false;
  }
  return sawPlaceholder && findEvictedPlaceholderFileInKeyDir(keyDir) !== null;
}
