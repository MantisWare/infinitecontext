import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREMERGE_MIN_NODE = [22, 12, 0];

/**
 * @param {string} versionText
 * @param {number[]} minParts
 */
export function parseNodeVersionParts(versionText, minParts = PREMERGE_MIN_NODE) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionText).trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {number[]} current
 * @param {number[]} minParts
 */
export function isNodeVersionAtLeast(current, minParts = PREMERGE_MIN_NODE) {
  for (let i = 0; i < 3; i += 1) {
    const a = current[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} repoRoot
 */
export function assertGitTreeClean(repoRoot) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  const dirty = String(res.stdout ?? "").trim();
  if (dirty) {
    throw new Error(`premerge refuses dirty working tree:\n${dirty}`);
  }
}

/**
 * @param {string} repoRoot
 * @param {string | undefined} expectedSha
 */
export function assertExpectedShaMatchesHead(repoRoot, expectedSha) {
  const normalized = String(expectedSha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("EXPECTED_SHA is required and must be a full 40-character git commit hex");
  }
  const headRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const head = String(headRes.stdout ?? "").trim().toLowerCase();
  if (head !== normalized) {
    throw new Error(`EXPECTED_SHA mismatch: expected ${normalized}, HEAD is ${head}`);
  }
  return head;
}

/**
 * @param {string} output
 */
export function absorbNodeTestTotals(output) {
  /** @type {{ pass: number, fail: number, skipped: number, tests: number }} */
  const totals = { pass: 0, fail: 0, skipped: 0, tests: 0 };
  for (const line of output.split("\n")) {
    const pass = line.match(/^# pass (\d+)$/);
    const fail = line.match(/^# fail (\d+)$/);
    const skipped = line.match(/^# skipped (\d+)$/);
    const tests = line.match(/^# tests (\d+)$/);
    if (pass) {
      totals.pass += Number(pass[1]);
    }
    if (fail) {
      totals.fail += Number(fail[1]);
    }
    if (skipped) {
      totals.skipped += Number(skipped[1]);
    }
    if (tests) {
      totals.tests += Number(tests[1]);
    }
  }
  return totals;
}

export function resolveRepoRootsFromImportMeta(importMetaUrl) {
  const sdkRoot = path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
  const repoRoot = path.resolve(sdkRoot, "../..");
  return { sdkRoot, repoRoot };
}
