/**
 * Tracks mkdtemp dirs under os.tmpdir() with an `ic-` prefix and removes them on exit/signal.
 * Loaded via NODE_OPTIONS or test --import hooks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @type {Set<string>} */
const trackedIcTmpDirs = new Set();

const tmpRoot = path.resolve(os.tmpdir());

function shouldTrackDir(dir) {
  const resolved = path.resolve(String(dir));
  if (!resolved.startsWith(`${tmpRoot}${path.sep}`)) {
    return false;
  }
  const base = path.basename(resolved);
  return base.startsWith("ic-");
}

function trackDir(dir) {
  if (shouldTrackDir(dir)) {
    trackedIcTmpDirs.add(path.resolve(dir));
  }
}

const originalMkdtempSync = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = (prefix, options) => {
  const dir = originalMkdtempSync(prefix, options);
  trackDir(dir);
  return dir;
};

if (fs.promises?.mkdtemp) {
  const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
  fs.promises.mkdtemp = async (prefix, options) => {
    const dir = await originalMkdtemp(prefix, options);
    trackDir(dir);
    return dir;
  };
}

function cleanupTrackedIcTmpDirs() {
  for (const dir of trackedIcTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  trackedIcTmpDirs.clear();
}

process.once("exit", cleanupTrackedIcTmpDirs);
process.once("SIGINT", () => {
  cleanupTrackedIcTmpDirs();
  const listeners = process.listeners("SIGINT");
  if (listeners.length <= 1) {
    process.exit(130);
  }
});
process.once("SIGTERM", () => {
  cleanupTrackedIcTmpDirs();
  const listeners = process.listeners("SIGTERM");
  if (listeners.length <= 1) {
    process.exit(143);
  }
});
