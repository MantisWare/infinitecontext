import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PREMERGE_MIN_NODE,
  absorbNodeTestTotals,
  assertExpectedShaMatchesHead,
  assertGitTreeClean,
  assertNoNewIcTmpDirLeaks,
  assertPremergeExpectedPackagesDefineTestScript,
  assertPremergePackageTestSections,
  assertPremergeTestTotalsValid,
  isNodeVersionAtLeast,
  PREMERGE_PACKAGE_MIN_PASS,
  listAllIcTmpDirs,
  parseNodeVersionParts,
  parsePremergePackageCounts,
  resolveRepoRootsFromImportMeta,
} from "./premerge-lib.mjs";
import {
  assertPremergePostgresUrlsSafe,
  startEphemeralPostgresForPremerge,
} from "./premerge-ephemeral-postgres.mjs";

const { sdkRoot, repoRoot } = resolveRepoRootsFromImportMeta(import.meta.url);

const icTestTmpRunTag = `ic-premerge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
process.env.IC_TEST_TMP_RUN_TAG = icTestTmpRunTag;

const callerTmpRoot = path.resolve(process.env.TMPDIR ?? os.tmpdir());
/** @type {string} */
const premergeTmpRoot = fs.mkdtempSync(path.join(callerTmpRoot, `${icTestTmpRunTag}-tmpdir-`));
process.env.TMPDIR = premergeTmpRoot;
process.env.TMP = premergeTmpRoot;
process.env.TEMP = premergeTmpRoot;
process.env.IC_PREMERGE_TMPDIR = premergeTmpRoot;
console.log(`premerge: private TMPDIR=${premergeTmpRoot}`);

const minioPort = String(process.env.IC_STORAGE_EMU_MINIO_PORT ?? "9000");
const sftpPort = String(process.env.IC_STORAGE_EMU_SFTP_PORT ?? "2222");

/** @type {{ pass: number, fail: number, skipped: number, tests: number }} */
const totals = { pass: 0, fail: 0, skipped: 0, tests: 0 };

/** @type {import("node:child_process").ChildProcess | null} */
let activeChild = null;
let shuttingDown = false;

/** Set true before storage:emu:up so failed starts still run storage:emu:down. */
let emuStarted = false;
let cleaning = false;
/** @type {null | (() => void)} */
let pgCleanup = null;

function fail(message, code = 1) {
  console.error(message);
  killActiveProcessGroup("SIGKILL");
  cleanupAll();
  cleanupPremergeTmpRoot();
  process.exit(code);
}

function cleanupNodeCompileCache() {
  const root = process.env.IC_PREMERGE_TMPDIR ?? premergeTmpRoot;
  if (!root || !fs.existsSync(root)) {
    return;
  }
  const cacheDir = path.join(root, "node-compile-cache");
  try {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}

function cleanupPremergeTmpRoot() {
  cleanupNodeCompileCache();
  const root = process.env.IC_PREMERGE_TMPDIR ?? premergeTmpRoot;
  if (!root || !fs.existsSync(root)) {
    return;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function finalizeTmpHygiene(icTmpBeforeTests) {
  try {
    assertNoNewIcTmpDirLeaks(icTmpBeforeTests, listAllIcTmpDirs(icTestTmpRunTag));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  cleanupPremergeTmpRoot();
}

function cleanupAll() {
  cleanupEmu();
  if (pgCleanup) {
    pgCleanup();
    pgCleanup = null;
  }
}

function loadApiEnvFile() {
  const envLocal = path.join(repoRoot, "apps/api/.env.local");
  if (!fs.existsSync(envLocal)) {
    return;
  }
  for (const line of fs.readFileSync(envLocal, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * @param {NodeJS.Signals} signal
 */
function killActiveProcessGroup(signal) {
  const child = activeChild;
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 * @param {{ allowFailure?: boolean }} [opts]
 * @returns {Promise<string>}
 */
function run(cmd, args, env, cwd = sdkRoot, opts = {}) {
  const { allowFailure = false } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["inherit", "pipe", "pipe"],
      detached: true,
    });
    activeChild = child;
    /** @type {string} */
    let out = "";
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      out += text;
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      out += text;
      process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      activeChild = null;
      reject(err);
    });
    child.on("close", (status, signal) => {
      activeChild = null;
      if (signal) {
        reject(new Error(`${cmd} ${args.join(" ")} terminated by ${signal}`));
        return;
      }
      if (status !== 0) {
        if (allowFailure) {
          reject(new Error(`${cmd} ${args.join(" ")} exited ${status ?? 1}`));
          return;
        }
        killActiveProcessGroup("SIGKILL");
        cleanupAll();
        process.exit(status ?? 1);
      }
      resolve(out);
    });
  });
}

function cleanupEmu() {
  if (cleaning) {
    return;
  }
  cleaning = true;
  if (!emuStarted) {
    return;
  }
  spawnSync("npm", ["run", "storage:emu:down"], {
    cwd: sdkRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      IC_STORAGE_EMU_MINIO_PORT: minioPort,
      IC_STORAGE_EMU_SFTP_PORT: sftpPort,
    },
  });
  emuStarted = false;
}

/**
 * @param {NodeJS.Signals} signal
 */
function onSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  killActiveProcessGroup("SIGTERM");
  setTimeout(() => killActiveProcessGroup("SIGKILL"), 5000).unref();
  cleanupNodeCompileCache();
  cleanupPremergeTmpRoot();
  cleanupAll();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("exit", () => {
  if (!shuttingDown) {
    killActiveProcessGroup("SIGTERM");
  }
  cleanupAll();
});
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

const nodeParts = parseNodeVersionParts(process.version);
if (!nodeParts || !isNodeVersionAtLeast(nodeParts, PREMERGE_MIN_NODE)) {
  fail(
    `premerge requires Node >=${PREMERGE_MIN_NODE.join(".")} (current ${process.version}). See apps/js-sdk/package.json engines.`,
  );
}

try {
  assertGitTreeClean(repoRoot);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/** @type {string} */
let head;
try {
  head = assertExpectedShaMatchesHead(repoRoot, process.env.EXPECTED_SHA);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

await run("npm", ["run", "guard:12"]);
await run("node", ["scripts/check-lib-no-test-env.mjs"]);
loadApiEnvFile();
for (const key of ["SYNC_E2E_DATABASE_URL", "VAULT_E2E_DATABASE_URL"]) {
  delete process.env[key];
}
try {
  assertPremergePostgresUrlsSafe(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
try {
  const pg = startEphemeralPostgresForPremerge(repoRoot, process.env);
  pgCleanup = pg.cleanup;
  console.log(
    `premerge: ephemeral Postgres project=${pg.project} port=${pg.port} dbs=${pg.syncDb},${pg.vaultDb}`,
  );
  process.env.MIGRATION_VERIFY_USE_HOST = "1";
  process.env.MIGRATION_VERIFY_USE_DOCKER = "";
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

await run("pnpm", ["-r", "check"], {}, repoRoot);

const emuComposeEnv = {
  IC_STORAGE_EMU_MINIO_PORT: minioPort,
  IC_STORAGE_EMU_SFTP_PORT: sftpPort,
  AWS_ENDPOINT_URL: `http://127.0.0.1:${minioPort}`,
};

console.log(
  `premerge: starting storage emulator (MinIO 127.0.0.1:${minioPort}, SFTP 127.0.0.1:${sftpPort})…`,
);
emuStarted = true;
try {
  await run("npm", ["run", "storage:emu:up"], emuComposeEnv);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const emuEnv = {
  IC_TEST_TMP_RUN_TAG: icTestTmpRunTag,
  IC_REQUIRE_MINIO: "1",
  IC_STORAGE_EMU_MINIO_PORT: minioPort,
  IC_STORAGE_EMU_SFTP_PORT: sftpPort,
  AWS_ACCESS_KEY_ID: "minioadmin",
  AWS_SECRET_ACCESS_KEY: "minioadmin",
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT_URL: `http://127.0.0.1:${minioPort}`,
  INFINITECONTEXT_S3_TEST_BUCKET: "infinitecontext-ci",
  INFINITECONTEXT_S3_TEST_PREFIX: "premerge-local",
};

try {
  assertPremergeExpectedPackagesDefineTestScript(repoRoot);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const icTmpBeforeTests = listAllIcTmpDirs(icTestTmpRunTag);

let testOut = "";
let testRunFailed = false;
try {
  testOut = await run(
    "pnpm",
    ["-r", "--workspace-concurrency=1", "test"],
    emuEnv,
    repoRoot,
    { allowFailure: true },
  );
} catch {
  testRunFailed = true;
} finally {
  cleanupAll();
  finalizeTmpHygiene(icTmpBeforeTests);
}

if (testRunFailed) {
  process.exit(1);
}

const parsed = absorbNodeTestTotals(testOut);
totals.pass = parsed.pass;
totals.fail = parsed.fail;
totals.skipped = parsed.skipped;
totals.tests = parsed.tests;

try {
  assertPremergeTestTotalsValid({ ...totals, blocks: parsed.blocks });
  assertPremergePackageTestSections(testOut);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

try {
  head = assertExpectedShaMatchesHead(repoRoot, process.env.EXPECTED_SHA);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const packageCounts = parsePremergePackageCounts(testOut);

console.log("");
console.log("premerge summary:");
console.log(`  pass: ${totals.pass}`);
console.log(`  fail: ${totals.fail}`);
console.log(`  skipped: ${totals.skipped}`);
console.log(`  tests: ${totals.tests}`);
console.log(`  HEAD: ${head}`);
console.log("  per-package (floor pass):");
for (const [name, row] of [...packageCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const floor = PREMERGE_PACKAGE_MIN_PASS[name];
  const floorLabel = floor !== undefined ? ` floor ${floor}` : "";
  console.log(
    `    ${name}: pass ${row.pass}, fail ${row.fail}, skipped ${row.skipped}, tests ${row.tests} (${row.blocks} block(s))${floorLabel}`,
  );
}

if (totals.fail > 0) {
  process.exit(1);
}
