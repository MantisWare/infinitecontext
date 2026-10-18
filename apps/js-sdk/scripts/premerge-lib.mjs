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
  const raw = String(expectedSha ?? "").trim();
  if (/[A-F]/.test(raw)) {
    throw new Error("EXPECTED_SHA must be lowercase hex (git rev-parse HEAD)");
  }
  const normalized = raw.toLowerCase();
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
 * Sum Node test runner summaries (one block per process, anchored at `# duration_ms`).
 * Ignores intermediate `# pass` lines emitted during subtests.
 * @param {string} output
 */
export function absorbNodeTestTotals(output) {
  /** @type {{ pass: number, fail: number, skipped: number, tests: number, blocks: number }} */
  const totals = { pass: 0, fail: 0, skipped: 0, tests: 0, blocks: 0 };
  const blocks = output.split(/# duration_ms \d+/);
  for (const part of blocks) {
    const tests = [...part.matchAll(/^# tests (\d+)$/gm)].at(-1);
    const pass = [...part.matchAll(/^# pass (\d+)$/gm)].at(-1);
    const fail = [...part.matchAll(/^# fail (\d+)$/gm)].at(-1);
    const skipped = [...part.matchAll(/^# skipped (\d+)$/gm)].at(-1);
    if (!tests || !pass || !fail || !skipped) {
      continue;
    }
    totals.tests += Number(tests[1]);
    totals.pass += Number(pass[1]);
    totals.fail += Number(fail[1]);
    totals.skipped += Number(skipped[1]);
    totals.blocks += 1;
  }
  return totals;
}

/**
 * @param {{ pass: number, fail: number, skipped: number, tests: number, blocks?: number }} totals
 */
export function assertPremergeTestTotalsValid(totals) {
  if ((totals.blocks ?? 0) === 0 || totals.tests === 0) {
    throw new Error(
      "premerge could not parse any Node test summary blocks (# tests … # duration_ms); refusing false-green",
    );
  }
  const accounted = totals.pass + totals.fail + totals.skipped;
  if (accounted !== totals.tests) {
    throw new Error(
      `premerge test totals inconsistent: pass+fail+skipped=${accounted} but tests=${totals.tests}`,
    );
  }
}

export function resolveRepoRootsFromImportMeta(importMetaUrl) {
  const sdkRoot = path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
  const repoRoot = path.resolve(sdkRoot, "../..");
  return { sdkRoot, repoRoot };
}
