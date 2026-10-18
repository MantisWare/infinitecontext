import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

/**
 * @param {string} databaseUrl
 */
export function postgresProbeTargetFromUrl(databaseUrl) {
  const parsed = new URL(String(databaseUrl).replace(/^postgres:/, "postgresql:"));
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port || "5432";
  const user = decodeURIComponent(parsed.username || "infinitecontext");
  const database = parsed.pathname.replace(/^\//, "") || "postgres";
  return { host, port, user, database };
}

/** Minimum Node-reported tests per workspace package (QA reproducible baseline). */
export const PREMERGE_PACKAGE_MIN_TESTS = {
  "@infinitecontext/core": 170,
  "@infinitecontext/crypto": 20,
  "@infinitecontext/parsers": 65,
  "@infinitecontext/sync": 25,
  "@infinitecontext/auth": 10,
  "@infinitecontext/storage": 1,
  "infinitecontext-api": 90,
  infinitecontext: 530,
  "infinitecontext-mcp-server": 1,
  "infinitecontext-python-sdk": 0,
};

/**
 * @param {string} raw
 */
function normalizePremergePackageName(raw) {
  let name = String(raw ?? "").trim();
  if (name.startsWith("@")) {
    const versionAt = name.indexOf("@", 1);
    if (versionAt > 0) {
      name = name.slice(0, versionAt);
    }
  } else {
    name = name.replace(/@\d+\.\d+\.\d+.*$/, "");
  }
  return name.replace(/@$/, "").trim();
}

/**
 * @param {string} section
 */
function absorbSectionTotals(section) {
  /** @type {{ pass: number, fail: number, skipped: number, tests: number, blocks: number }} */
  const totals = { pass: 0, fail: 0, skipped: 0, tests: 0, blocks: 0 };
  for (const part of section.split(/# duration_ms \d+/)) {
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
 * @param {string} output
 * @returns {Map<string, { pass: number, fail: number, skipped: number, tests: number, blocks: number }>}
 */
export function parsePremergePackageCounts(output) {
  /** @type {Map<string, { pass: number, fail: number, skipped: number, tests: number, blocks: number }>} */
  const byPackage = new Map();
  const headers = [...output.matchAll(/^> (.+?) test .+$/gm)];
  for (let i = 0; i < headers.length; i += 1) {
    const start = headers[i].index ?? 0;
    const end = i + 1 < headers.length ? headers[i + 1].index ?? output.length : output.length;
    const section = output.slice(start, end);
    const name = normalizePremergePackageName(headers[i][1]);
    const totals = absorbSectionTotals(section);
    if (name.includes("python-sdk") && totals.blocks === 0) {
      const pytest = section.match(/(\d+) passed/);
      if (pytest) {
        totals.tests = Number(pytest[1]);
        totals.pass = Number(pytest[1]);
        totals.blocks = 1;
      } else if (/python-sdk: skipping tests/.test(section)) {
        totals.tests = 0;
        totals.pass = 0;
        totals.fail = 0;
        totals.skipped = 0;
        totals.blocks = 1;
        totals.pythonSkipped = true;
      }
    }
    byPackage.set(name, totals);
  }
  return byPackage;
}

/**
 * @param {string} output
 */
export function assertPremergePackageTestSections(output) {
  const byPackage = parsePremergePackageCounts(output);
  /** @type {string[]} */
  const problems = [];
  for (const [name, totals] of byPackage) {
    if (totals.blocks === 0) {
      problems.push(`${name}: missing test summary block`);
      continue;
    }
    if (totals.tests === 0 && !totals.pythonSkipped) {
      problems.push(`${name}: matched 0 tests (empty glob or describe.skip-only suite)`);
    }
    const min = PREMERGE_PACKAGE_MIN_TESTS[name];
    if (min !== undefined && totals.tests < min) {
      problems.push(`${name}: tests ${totals.tests} < expected minimum ${min}`);
    }
    const accounted = totals.pass + totals.fail + totals.skipped;
    if (accounted !== totals.tests) {
      problems.push(`${name}: pass+fail+skipped (${accounted}) ≠ tests (${totals.tests})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`premerge package test coverage failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/** @returns {Set<string>} */
export function listAllIcTmpDirs() {
  const tmpRoot = path.resolve(os.tmpdir());
  /** @type {Set<string>} */
  const found = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!name.startsWith("ic-")) {
      continue;
    }
    found.add(path.join(tmpRoot, name));
  }
  return found;
}

/**
 * @param {Set<string>} before
 * @param {Set<string>} after
 */
export function assertNoNewIcTmpDirLeaks(before, after) {
  /** @type {string[]} */
  const leaked = [];
  for (const dir of after) {
    if (!before.has(dir)) {
      leaked.push(dir);
    }
  }
  if (leaked.length > 0) {
    throw new Error(
      `premerge left new /tmp/ic-* directories behind (${leaked.length}): ${leaked.slice(0, 8).join(", ")}${leaked.length > 8 ? "…" : ""}`,
    );
  }
}

export function resolveRepoRootsFromImportMeta(importMetaUrl) {
  const sdkRoot = path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
  const repoRoot = path.resolve(sdkRoot, "../..");
  return { sdkRoot, repoRoot };
}
