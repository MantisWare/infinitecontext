import { createRequire } from "node:module";
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

/**
 * Minimum pass counts measured with node-pty unavailable (native module missing or
 * `IC_PREMERGE_FORCE_NO_PTY=1` on the premerge process). Floors must equal measured pass counts exactly.
 * @type {Record<string, number>}
 */
export const PREMERGE_PACKAGE_MIN_PASS = {
  "@infinitecontext/auth": 11,
  "@infinitecontext/core": 179,
  "@infinitecontext/crypto": 23,
  "@infinitecontext/parsers": 115,
  "@infinitecontext/storage": 3,
  "@infinitecontext/sync": 27,
  "@infinitecontext/sync-cursor": 1,
  infinitecontext: 656,
  "infinitecontext-api": 93,
  "infinitecontext-mcp-server": 2,
  "infinitecontext-python-sdk": 6,
};

/** Measured infinitecontext pass when node-pty loads (onboarding wizard e2e suite runs). */
export const PREMERGE_INFINITECONTEXT_MIN_PASS_WITH_PTY = 669;

/** Onboarding wizard e2e tests when node-pty loads (describe.skip when absent). */
export const PREMERGE_ONBOARDING_PTY_TEST_COUNT = 13;

export const PREMERGE_EXPECTED_PACKAGE_NAMES = Object.keys(PREMERGE_PACKAGE_MIN_PASS);

/**
 * Whether node-pty loads for onboarding wizard e2e. Force off with `IC_PREMERGE_FORCE_NO_PTY=1`
 * on the premerge process (same floors as CI without the native module).
 * @param {string} sdkRoot
 */
export function isNodePtyLoadable(sdkRoot) {
  if (String(process.env.IC_PREMERGE_FORCE_NO_PTY ?? "").trim() === "1") {
    return false;
  }
  try {
    const req = createRequire(path.join(sdkRoot, "package.json"));
    req.resolve("node-pty");
    req("node-pty");
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} sdkRoot
 */
export function warnIfNodePtyMissing(sdkRoot) {
  if (!isNodePtyLoadable(sdkRoot)) {
    console.error(
      `WARNING: node-pty is not loadable — onboarding wizard e2e (${PREMERGE_ONBOARDING_PTY_TEST_COUNT} tests) will not run and are not counted in skipped totals (environmental silent drop vs js-sdk floor baseline).`,
    );
  }
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function assertPremergeRejectsAllowLibTestEnv(env) {
  const raw = String(env.ALLOW_LIB_TEST_ENV ?? "").trim();
  if (raw === "1" || raw.toLowerCase() === "true") {
    throw new Error(
      "premerge refuses ALLOW_LIB_TEST_ENV — lib/ TEST env guard bypass is not allowed in premerge/CI (unset ALLOW_LIB_TEST_ENV)",
    );
  }
}

/**
 * @param {boolean} [nodePtyLoadable]
 */
export function infinitecontextMinPassFloor(nodePtyLoadable = false) {
  return nodePtyLoadable
    ? PREMERGE_INFINITECONTEXT_MIN_PASS_WITH_PTY
    : PREMERGE_PACKAGE_MIN_PASS.infinitecontext;
}

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
      const skippedPy = section.match(/(\d+) skipped/);
      const errorsPy = section.match(/(\d+) error/);
      const failCount = (failed ? Number(failed[1]) : 0) + (errorsPy ? Number(errorsPy[1]) : 0);
      const passCount = passed ? Number(passed[1]) : 0;
      const skipCount = skippedPy ? Number(skippedPy[1]) : 0;
      if (failCount > 0 || passCount > 0 || skipCount > 0) {
        totals.tests = passCount + failCount + skipCount;
        totals.pass = passCount;
        totals.fail = failCount;
        totals.skipped = skipCount;
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

/**
 * @param {string} output
 * @param {{ nodePtyLoadable?: boolean }} [opts]
 */
export function assertPremergePackageTestSections(output, opts = {}) {
  const { nodePtyLoadable = false } = opts;
  const byPackage = parsePremergePackageCounts(output);
  /** @type {string[]} */
  const problems = [];
  for (const expectedName of PREMERGE_EXPECTED_PACKAGE_NAMES) {
    if (!byPackage.has(expectedName)) {
      problems.push(`${expectedName}: missing from pnpm test output (no > pkg test section)`);
    }
  }
  for (const [name, totals] of byPackage) {
    if (totals.blocks === 0) {
      problems.push(`${name}: missing test summary block`);
      continue;
    }
    if (totals.pythonVenvUnavailable) {
      problems.push(PREMERGE_PYTHON_SDK_VENV_FAIL_HINT);
      continue;
    }
    if (totals.fail > 0) {
      problems.push(`${name}: ${totals.fail} failed test(s) in reporter output`);
    }
    if (totals.tests === 0) {
      problems.push(`${name}: matched 0 tests (empty glob or describe.skip-only suite)`);
    }
    let minPass = PREMERGE_PACKAGE_MIN_PASS[name];
    if (name === "infinitecontext") {
      minPass = infinitecontextMinPassFloor(nodePtyLoadable);
    }
    if (minPass !== undefined && totals.pass !== minPass) {
      const ptyNote = name === "infinitecontext" && nodePtyLoadable ? " (with node-pty)" : " (no node-pty baseline)";
      const relation = totals.pass < minPass ? "<" : ">";
      problems.push(
        `${name}: pass ${totals.pass} ${relation} floor ${minPass} (exact count required)${ptyNote}`,
      );
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
/**
 * @param {string} [tmpRootOverride] When set (premerge private TMPDIR), scan only that directory.
 */
/**
 * @param {string} dirPath
 */
export function isPremergeToolingCacheDir(dirPath) {
  const base = path.basename(dirPath);
  return base === "node-compile-cache" || /^v8-compile-cache-\d+$/.test(base);
}

/** @param {string} dirPath */
export function isEphemeralPremergeTestFixtureDir(dirPath) {
  const base = path.basename(dirPath);
  return (
    base.startsWith("ic-b1-offset-") ||
    base.startsWith("ic-b1-race-") ||
    base.startsWith("ic-m6-path-") ||
    base.startsWith("ic-group-kill-") ||
    base.startsWith("ic-m1b-group-") ||
    base.startsWith("ic-sm7-group-") ||
    base.startsWith("ic-sm7-skip-") ||
    base.startsWith("ic-env-strip-")
  );
}

export function listAllIcTmpDirs(tmpRootOverride) {
  const tmpRoot = path.resolve(
    tmpRootOverride ?? process.env.IC_PREMERGE_TMPDIR ?? process.env.TMPDIR ?? os.tmpdir(),
  );
  /** @type {Set<string>} */
  const found = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return found;
  }
  for (const name of entries) {
    const full = path.join(tmpRoot, name);
    try {
      if (fs.statSync(full).isDirectory()) {
        found.add(full);
      }
    } catch {
      /* ignore */
    }
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
    if (before.has(dir)) {
      continue;
    }
    if (isPremergeToolingCacheDir(dir)) {
      continue;
    }
    if (isEphemeralPremergeTestFixtureDir(dir)) {
      continue;
    }
    leaked.push(dir);
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
