import fs from "node:fs";
import path from "node:path";

import { rejectSymlinkInStoreRoot } from "./filesystem-paths.mjs";

const OBJECTS = "objects";

/**
 * Prepare a folder-backend ciphertext root (`objects/` skeleton).
 *
 * @param {string} rootDir
 */
export function initFolderStorageRoot(rootDir) {
  const root = path.resolve(String(rootDir ?? ""));
  rejectSymlinkInStoreRoot(root);
  const objects = path.join(root, OBJECTS);
  fs.mkdirSync(objects, { recursive: true, mode: 0o700 });
  return { rootDir: root, objectsDir: objects };
}
