import fs from "node:fs";

/** @param {string} rootDir */
export function ensurePrivateDir(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(rootDir, 0o700);
  } catch {
    // best effort on platforms without chmod semantics
  }
}
