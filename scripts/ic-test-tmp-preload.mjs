/**
 * Tracks mkdtemp dirs created by THIS process only; removes them on exit/signal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @type {Set<string>} */
const trackedIcTmpDirs = new Set();

const tmpRoot = path.resolve(os.tmpdir());
const runTag = String(process.env.IC_TEST_TMP_RUN_TAG ?? "").trim();

function basenameMatchesRunTag(base) {
  if (!runTag) {
    return base.startsWith("ic-");
  }
  return base.startsWith(`${runTag}-`) || base === runTag;
}

function mkdtempPrefix(label) {
  if (runTag) {
    return path.join(tmpRoot, `${runTag}-${label}-`);
  }
  return path.join(tmpRoot, "ic-");
}

function shouldTrackDir(dir) {
  const resolved = path.resolve(String(dir));
  if (!resolved.startsWith(`${tmpRoot}${path.sep}`)) {
    return false;
  }
  const base = path.basename(resolved);
  if (basenameMatchesRunTag(base)) {
    return true;
  }
  if (base.startsWith("ic-")) {
    return true;
  }
  return false;
}

function trackDir(dir) {
  if (shouldTrackDir(dir)) {
    trackedIcTmpDirs.add(path.resolve(dir));
  }
}

function maybeTrackToolingDir(targetPath) {
  const resolved = path.resolve(String(targetPath));
  if (!resolved.startsWith(`${tmpRoot}${path.sep}`) && resolved !== tmpRoot) {
    return;
  }
  const base = path.basename(resolved);
  if (
    base.startsWith("tsx-") ||
    base.includes("sync-pack-out-") ||
    base.includes("sync-pack-staging-")
  ) {
    trackedIcTmpDirs.add(resolved);
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

export function icTestTmpMkdtempPrefix(label = "") {
  return mkdtempPrefix(label);
}

export function listTrackedIcTmpDirsForRun() {
  return new Set(trackedIcTmpDirs);
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

function onSignalCleanup() {
  cleanupTrackedIcTmpDirs();
}

process.once("exit", () => {
  cleanupTrackedIcTmpDirs();
});
process.once("SIGINT", () => {
  onSignalCleanup();
  const listeners = process.listeners("SIGINT");
  if (listeners.length <= 1) {
    process.exit(130);
  }
});
process.once("SIGTERM", () => {
  onSignalCleanup();
  const listeners = process.listeners("SIGTERM");
  if (listeners.length <= 1) {
    process.exit(143);
  }
});
