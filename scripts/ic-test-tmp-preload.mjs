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
  // Tests often mkdtemp with an `ic-` prefix while premerge sets IC_TEST_TMP_RUN_TAG on dir names.
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

function cleanupLegacySyncPackOutDirs() {
  try {
    for (const name of fs.readdirSync(tmpRoot)) {
      const isLegacy = name.startsWith("ic-sync-pack-out-") || name.includes("sync-pack-out-");
      const isStaging = name.includes("sync-pack-staging-");
      if (!isLegacy && !isStaging) {
        continue;
      }
      if (runTag && !name.startsWith(`${runTag}-`) && !name.startsWith("ic-sync-pack-out-")) {
        continue;
      }
      const full = path.join(tmpRoot, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function onSignalCleanup() {
  cleanupTrackedIcTmpDirs();
  cleanupLegacySyncPackOutDirs();
}

process.once("exit", () => {
  cleanupTrackedIcTmpDirs();
  cleanupLegacySyncPackOutDirs();
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
