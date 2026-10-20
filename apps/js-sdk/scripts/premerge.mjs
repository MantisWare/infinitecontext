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
  warnIfNodePtyMissing,
  isNodePtyLoadable,
  assertPremergeRejectsAllowLibTestEnv,
} from "./premerge-lib.mjs";
import {
  assertPremergePostgresUrlsSafe,
  startEphemeralPostgresForPremerge,
} from "./premerge-ephemeral-postgres.mjs";
import { createPremergeShutdown } from "./premerge-shutdown.mjs";
import { syncVaultAgentCleanup } from "./premerge-vault-cleanup.mjs";

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

/** Set true before storage:emu:up so failed starts still run storage:emu:down. */
let emuStarted = false;
let cleaning = false;
/** @type {null | (() => void)} */
let pgCleanup = null;

/** @type {ReturnType<typeof createPremergeShutdown>} */
let shutdown;

/**
 * @param {NodeJS.Signals} signal
 */
function killActiveProcessGroup(signal) {
  void shutdown.terminateActiveLeg(signal);
}

function cleanupNodeCompileCache() {
  shutdown.cleanupNodeCompileCache();
}

function cleanupPremergeTmpRoot() {
  shutdown.cleanupPremergeTmpRoot();
}

function exitPremerge(code) {
  shutdown.exitPremerge(code);
}

function fail(message, code = 1) {
  shutdown.fail(message, code);
}

function finalizeTmpHygiene(icTmpBeforeTests) {
  shutdown.finalizeTmpHygiene(icTmpBeforeTests);
}

function run(cmd, args, env, cwd = sdkRoot, opts = {}) {
  return shutdown.run(cmd, args, env, cwd, opts);
}

function cleanupAll() {
  cleanupEmu();
  syncVaultAgentCleanup(sdkRoot);
  if (pgCleanup) {
    pgCleanup();
    pgCleanup = null;
  }
}

shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll,
  killActiveProcessGroup,
  assertNoNewIcTmpDirLeaks,
  listAllIcTmpDirs: () => listAllIcTmpDirs(premergeTmpRoot),
});

shutdown.registerSignalHandlers();

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

process.on("exit", () => {
  if (!shutdown.shuttingDown) {
    killActiveProcessGroup("SIGTERM");
  }
  cleanupAll();
});

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
    if (key === "EXPECTED_SHA") {
      continue;
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

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

try {
  assertPremergeRejectsAllowLibTestEnv(process.env);
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

const icTmpBeforeTests = listAllIcTmpDirs(premergeTmpRoot);
const nodePtyLoadable = isNodePtyLoadable(sdkRoot);
warnIfNodePtyMissing(sdkRoot);

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
  if (!shutdown.shuttingDown) {
    testRunFailed = true;
  }
} finally {
  cleanupAll();
  if (!shutdown.shuttingDown) {
    finalizeTmpHygiene(icTmpBeforeTests);
  }
}

await new Promise((resolve) => setImmediate(resolve));

if (testRunFailed && !shutdown.shuttingDown) {
  exitPremerge(1);
}

if (shutdown.shuttingDown) {
  exitPremerge(shutdown.shutdownExitCode ?? 130);
}

const parsed = absorbNodeTestTotals(testOut);
totals.pass = parsed.pass;
totals.fail = parsed.fail;
totals.skipped = parsed.skipped;
totals.tests = parsed.tests;

try {
  assertPremergeTestTotalsValid({ ...totals, blocks: parsed.blocks });
  assertPremergePackageTestSections(testOut, { nodePtyLoadable });
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
  await new Promise((resolve) => setImmediate(resolve));
  exitPremerge(1);
}

exitPremerge(0);
