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
 * Each workspace package `test` script must emit a Node summary block (or pytest banner for python-sdk).
 * @param {string} output
 */
export function assertPremergePackageTestSections(output) {
  /** @type {string[]} */
  const missing = [];
  const sections = output.split(/\n(?=> .+ test )/);
  for (const section of sections) {
    const header = section.match(/^> (.+?) test /);
    if (!header) {
      continue;
    }
    const name = header[1];
    const hasNodeSummary = /# duration_ms \d+/.test(section);
    const hasPytest =
      /(\d+) passed/.test(section) && name.includes("python-sdk");
    if (!hasNodeSummary && !hasPytest) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `premerge missing test summary for workspace package(s): ${missing.join(", ")} (refusing false-green)`,
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
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 */
export function assertPostgresReachableForPremerge(repoRoot, env = process.env) {
  const password = String(env.POSTGRES_PASSWORD ?? "").trim();
  if (!password) {
    throw new Error(
      "premerge: POSTGRES_PASSWORD is required for API live postgres suites. Set apps/api/.env.local or export POSTGRES_PASSWORD before running premerge.",
    );
  }
  const syncUrl =
    String(env.SYNC_E2E_DATABASE_URL ?? "").trim() ||
    `postgresql://infinitecontext@${env.PGHOST ?? "127.0.0.1"}:${env.PGPORT ?? "5433"}/infinitecontext`;
  const vaultUrl =
    String(env.VAULT_E2E_DATABASE_URL ?? "").trim() ||
    `postgresql://infinitecontext@${env.PGHOST ?? "127.0.0.1"}:${env.PGPORT ?? "5433"}/infinitecontext_vault_e2e`;

  /** @type {string[]} */
  const failures = [];
  for (const label of ["SYNC_E2E_DATABASE_URL", "VAULT_E2E_DATABASE_URL"]) {
    const url = label === "SYNC_E2E_DATABASE_URL" ? syncUrl : vaultUrl;
    const target = postgresProbeTargetFromUrl(url);
    const res = spawnSync(
      "psql",
      [
        "-h",
        target.host,
        "-p",
        target.port,
        "-U",
        target.user,
        "-d",
        target.database,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "SELECT 1",
      ],
      {
        encoding: "utf8",
        env: { ...env, PGPASSWORD: password },
      },
    );
    if (res.status !== 0) {
      const detail = String(res.stderr ?? res.stdout ?? "").trim().split("\n").pop();
      failures.push(
        `${label} (${target.host}:${target.port}/${target.database}): ${detail || "connection failed"}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `premerge: PostgreSQL probe failed (premerge will not run docker compose or touch the shared postgres project):\n${failures.map((f) => `  - ${f}`).join("\n")}\nStart Postgres yourself and fix POSTGRES_PASSWORD / database URLs, then retry.`,
    );
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
