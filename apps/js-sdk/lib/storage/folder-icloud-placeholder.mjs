import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { StorageError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

/** @param {string} targetPath absolute path to materialized file */
/**
 * @param {string} targetPath absolute path
 */
export function isEvictedICloudPlaceholderPath(targetPath) {
  const placeholder = icloudPlaceholderSiblingPath(targetPath);
  try {
    if (fs.existsSync(placeholder)) {
      return true;
    }
    if (fs.existsSync(targetPath)) {
      const st = fs.statSync(targetPath);
      if (st.isFile() && st.size === 0 && fs.existsSync(placeholder)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function icloudPlaceholderSiblingPath(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `.${base}.icloud`);
}

/**
 * @param {string} targetPath
 */
function targetLooksMaterialized(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    return st.isFile() && st.size > 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {string} targetPath
 * @param {{ timeoutMs?: number, useBrctl?: boolean, signal?: AbortSignal }} [opts]
 */
export async function ensureMaterializedLocalFile(targetPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  if (targetLooksMaterialized(targetPath)) {
    return;
  }

  const placeholderPath = icloudPlaceholderSiblingPath(targetPath);
  let placeholderExists = false;
  try {
    placeholderExists = fs.existsSync(placeholderPath);
  } catch {
    placeholderExists = false;
  }

  if (!placeholderExists && !fs.existsSync(targetPath)) {
    return;
  }

  if (!placeholderExists && fs.existsSync(targetPath)) {
    try {
      const st = fs.statSync(targetPath);
      if (st.isFile() && st.size === 0) {
        placeholderExists = true;
      }
    } catch {
      /* ignore */
    }
  }

  if (!placeholderExists) {
    return;
  }

  const started = Date.now();
  if (opts.useBrctl === true && process.platform === "darwin") {
    try {
      await execFileAsync("brctl", ["download", targetPath], { timeout: Math.min(timeoutMs, 5_000) });
    } catch {
      /* fall through to read polling */
    }
  }

  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) {
      throw new StorageError("iCloud placeholder download aborted", "evicted_placeholder");
    }
    if (targetLooksMaterialized(targetPath)) {
      return;
    }
    try {
      const fd = fs.openSync(targetPath, "r");
      fs.closeSync(fd);
      if (targetLooksMaterialized(targetPath)) {
        return;
      }
    } catch {
      /* still evicted */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new StorageError(
    `File is an evicted iCloud placeholder (not downloaded within ${timeoutMs}ms): ${targetPath}`,
    "evicted_placeholder",
  );
}
