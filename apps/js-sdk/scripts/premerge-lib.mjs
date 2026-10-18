import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

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

/**
 * Exact expected per-package totals (QA reproducible). Updated when tests are added/removed intentionally.
 * @type {Record<string, { pass: number, fail: number, skipped: number, tests: number }>}
 */
export const PREMERGE_PACKAGE_EXPECTED = {
  "@infinitecontext/auth": { pass: 11, fail: 0, skipped: 0, tests: 11 },
  "@infinitecontext/core": { pass: 179, fail: 0, skipped: 0, tests: 179 },
  "@infinitecontext/crypto": { pass: 23, fail: 0, skipped: 0, tests: 23 },
  "@infinitecontext/parsers": { pass: 115, fail: 0, skipped: 2, tests: 117 },
  "@infinitecontext/storage": { pass: 3, fail: 0, skipped: 0, tests: 3 },
  "@infinitecontext/sync": { pass: 27, fail: 0, skipped: 0, tests: 27 },
  infinitecontext: { pass: 560, fail: 0, skipped: 15, tests: 575 },
  "infinitecontext-api": { pass: 93, fail: 0, skipped: 0, tests: 93 },
  "infinitecontext-mcp-server": { pass: 2, fail: 0, skipped: 0, tests: 2 },
  "infinitecontext-python-sdk": { pass: 6, fail: 0, skipped: 0, tests: 6 },
};

/**
 * infinitecontext totals depend on node-pty (onboarding-wizard e2e is describe.skip without it).
 * @param {string} repoRoot
 */
export function getInfinitecontextExpectedTotals(repoRoot) {
  const hidden = countOnboardingWizardDescribeSkipTests(repoRoot);
  if (hidden > 0) {
    return { pass: 560, fail: 0, skipped: 15, tests: 575 };
  }
  return { pass: 575, fail: 0, skipped: 2, tests: 577 };
}

export const PREMERGE_EXPECTED_PACKAGE_NAMES = Object.keys(PREMERGE_PACKAGE_EXPECTED);

export const PREMERGE_PYTHON_SDK_VENV_FAIL_HINT =
  "premerge: infinitecontext-python-sdk did not run pytest — Python 3.8 .venv is required (0 tests is never a pass). " +
  "Setup: uv python install 3.8 && cd apps/python-sdk && uv venv --python 3.8 .venv && uv pip install -e '.[dev]' --python .venv/bin/python";

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
/**
 * @param {string} repoRoot
 */
export function countOnboardingWizardDescribeSkipTests(repoRoot) {
  const file = path.join(repoRoot, "apps/js-sdk/tests/onboarding-wizard.e2e.test.mjs");
  if (!fs.existsSync(file)) {
    return 0;
  }
  try {
    require("node-pty");
    return 0;
  } catch {
    const src = fs.readFileSync(file, "utf8");
    return (src.match(/\bit\s*\(/g) ?? []).length;
  }
}

/**
 * @param {{ pass: number, fail: number, skipped: number, tests: number }} totals
 * @param {string} repoRoot
 */
export function applyInfinitecontextDescribeSkipAdjustment(totals, repoRoot) {
  const hidden = countOnboardingWizardDescribeSkipTests(repoRoot);
  if (hidden <= 0) {
    return totals;
  }
  return {
    ...totals,
    skipped: totals.skipped + hidden,
    tests: totals.tests + hidden,
  };
}

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
      const failed = section.match(/(\d+) failed/);
      const passed = section.match(/(\d+) passed/);
      const failCount = failed ? Number(failed[1]) : 0;
      const passCount = passed ? Number(passed[1]) : 0;
      if (failCount > 0 || passCount > 0) {
        totals.tests = passCount + failCount;
        totals.pass = passCount;
        totals.fail = failCount;
        totals.blocks = 1;
      } else if (
        /python-sdk: (test|check) failed/.test(section) ||
        /python-sdk: FAIL — Python 3\.8 .venv is required/.test(section) ||
        /python-sdk: skipping tests/.test(section)
      ) {
        totals.tests = 0;
        totals.pass = 0;
        totals.fail = 0;
        totals.skipped = 0;
        totals.blocks = 1;
        totals.pythonVenvUnavailable = true;
      }
    }
    byPackage.set(name, totals);
  }
  return byPackage;
}

/**
 * @param {string} output
 */
/**
 * @param {string} output
 * @param {string} [repoRoot]
 */
/**
 * @param {string} repoRoot
 */
export function assertPremergeExpectedPackagesDefineTestScript(repoRoot) {
  /** @type {Map<string, string>} */
  const nameToDir = new Map();
  for (const base of ["apps", "packages"]) {
    const basePath = path.join(repoRoot, base);
    if (!fs.existsSync(basePath)) {
      continue;
    }
    for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(basePath, entry.name);
      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) {
        continue;
      }
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (typeof pkg.name === "string" && pkg.name.trim()) {
          nameToDir.set(pkg.name.trim(), dir);
        }
      } catch {
        /* ignore */
      }
    }
  }
  /** @type {string[]} */
  const problems = [];
  for (const expectedName of PREMERGE_EXPECTED_PACKAGE_NAMES) {
    const dir = nameToDir.get(expectedName);
    if (!dir) {
      problems.push(`${expectedName}: no workspace package.json found`);
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const testScript = pkg.scripts?.test;
    if (typeof testScript !== "string" || !testScript.trim()) {
      problems.push(`${expectedName}: missing scripts.test (${path.relative(repoRoot, dir)})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `premerge expected packages must define scripts.test:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

export function assertPremergePackageTestSections(output, repoRoot) {
  const byPackage = parsePremergePackageCounts(output);
  /** @type {string[]} */
  const problems = [];
  for (const expectedName of PREMERGE_EXPECTED_PACKAGE_NAMES) {
    if (!byPackage.has(expectedName)) {
      problems.push(`${expectedName}: missing from pnpm test output (no > pkg test section)`);
    }
  }
  for (const [name, rawTotals] of byPackage) {
    let totals = rawTotals;
    if (name === "infinitecontext" && repoRoot) {
      totals = applyInfinitecontextDescribeSkipAdjustment({ ...rawTotals }, repoRoot);
    }
    if (totals.blocks === 0) {
      problems.push(`${name}: missing test summary block`);
      continue;
    }
    if (totals.pythonVenvUnavailable) {
      problems.push(PREMERGE_PYTHON_SDK_VENV_FAIL_HINT);
      continue;
    }
    if (totals.tests === 0) {
      problems.push(`${name}: matched 0 tests (empty glob or describe.skip-only suite)`);
    }
    const expected =
      name === "infinitecontext" && repoRoot
        ? getInfinitecontextExpectedTotals(repoRoot)
        : PREMERGE_PACKAGE_EXPECTED[name];
    if (expected) {
      for (const key of ["pass", "fail", "skipped", "tests"]) {
        if (totals[key] !== expected[key]) {
          problems.push(
            `${name}: ${key} ${totals[key]} ≠ expected ${expected[key]} (QA reproducible baseline)`,
          );
        }
      }
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

/**
 * @param {string} [runTag] IC_TEST_TMP_RUN_TAG — when set, only dirs for this premerge run.
 * @returns {Set<string>}
 */
export function listAllIcTmpDirs(runTag = process.env.IC_TEST_TMP_RUN_TAG) {
  const tmpRoot = path.resolve(os.tmpdir());
  /** @type {Set<string>} */
  const found = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return found;
  }
  const tag = String(runTag ?? "").trim();
  for (const name of entries) {
    if (tag) {
      if (!name.startsWith(`${tag}-`) && name !== tag) {
        continue;
      }
    } else if (!name.startsWith("ic-")) {
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
      `premerge left new temp directories behind in private TMPDIR (${leaked.length}): ${leaked.slice(0, 8).join(", ")}${leaked.length > 8 ? "…" : ""}`,
    );
  }
}

export function resolveRepoRootsFromImportMeta(importMetaUrl) {
  const sdkRoot = path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
  const repoRoot = path.resolve(sdkRoot, "../..");
  return { sdkRoot, repoRoot };
}
