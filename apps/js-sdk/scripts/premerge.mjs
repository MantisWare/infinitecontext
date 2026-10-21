import { spawnSync } from "node:child_process";
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
  infinitecontextMinPassFloor,
} from "./premerge-lib.mjs";
import {
  assertPremergePostgresUrlsSafe,
  startEphemeralPostgresForPremerge,
} from "./premerge-ephemeral-postgres.mjs";
import { createPremergeShutdown } from "./premerge-shutdown.mjs";
import { syncVaultAgentCleanup } from "./premerge-vault-cleanup.mjs";
import { premergeProbeTestOutput } from "./premerge-probe-output.mjs";

const { sdkRoot, repoRoot } = resolveRepoRootsFromImportMeta(import.meta.url);

const icTestTmpRunTag = `ic-premerge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
process.env.IC_TEST_TMP_RUN_TAG = icTestTmpRunTag;

const callerTmpRoot = path.resolve(process.env.TMPDIR ?? os.tmpdir());
/** @type {string} */
const premergeTmpRoot = fs.mkdtempSync(path.join(callerTmpRoot, `${icTestTmpRunTag}-tmpdir-`));
/** @type {string} */
const premergeHome = fs.mkdtempSync(path.join(premergeTmpRoot, "home-"));
/** @type {string} */
const vaultPidRegistryPath = path.join(premergeTmpRoot, "vault-agent-pids.txt");

process.env.TMPDIR = premergeTmpRoot;
process.env.TMP = premergeTmpRoot;
process.env.TEMP = premergeTmpRoot;
process.env.IC_PREMERGE_TMPDIR = premergeTmpRoot;
process.env.HOME = premergeHome;
process.env.IC_PREMERGE_HOME = premergeHome;
process.env.IC_PREMERGE_VAULT_PID_REGISTRY = vaultPidRegistryPath;
process.env.DISABLE_V8_COMPILE_CACHE = "1";
console.log(`premerge: private TMPDIR=${premergeTmpRoot}`);
console.log(`premerge: isolated HOME=${premergeHome}`);
console.log(`premerge: node pid=${process.pid}`);

const minioPort = String(process.env.IC_STORAGE_EMU_MINIO_PORT ?? "9000");
const sftpPort = String(process.env.IC_STORAGE_EMU_SFTP_PORT ?? "2222");

/** @type {{ pass: number, fail: number, skipped: number, tests: number }} */
const totals = { pass: 0, fail: 0, skipped: 0, tests: 0 };

let emuStarted = false;
let cleaning = false;
/** @type {null | (() => void)} */
let pgCleanup = null;

/** @type {ReturnType<typeof createPremergeShutdown>} */
let shutdown;

function killActiveProcessGroup(signal) {
  void shutdown.terminateActiveLeg(signal);
}

function exitPremerge(code) {
  shutdown.exitPremerge(code);
}

async function fail(message, code = 1) {
  await shutdown.fail(message, code);
}

function cleanupAll() {
  cleanupEmu();
  syncVaultAgentCleanup({
    sdkRoot,
    premergeHome,
    vaultPidRegistryPath,
  });
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

function premergeChildEnv(extra = {}) {
  const forceNoPty = String(process.env.IC_PREMERGE_FORCE_NO_PTY ?? "").trim() === "1";
  return {
    ...process.env,
    HOME: premergeHome,
    IC_PREMERGE_HOME: premergeHome,
    IC_PREMERGE_VAULT_PID_REGISTRY: vaultPidRegistryPath,
    TMPDIR: premergeTmpRoot,
    TMP: premergeTmpRoot,
    TEMP: premergeTmpRoot,
    IC_PREMERGE_TMPDIR: premergeTmpRoot,
    DISABLE_V8_COMPILE_CACHE: "1",
    ...(forceNoPty ? { IC_PREMERGE_FORCE_NO_PTY: "1" } : {}),
    ...extra,
  };
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
    timeout: shutdown?.shuttingDown ? 25_000 : undefined,
    env: premergeChildEnv({
      IC_STORAGE_EMU_MINIO_PORT: minioPort,
      IC_STORAGE_EMU_SFTP_PORT: sftpPort,
    }),
  });
  emuStarted = false;
}

process.on("exit", () => {
  if (!shutdown.shuttingDown) {
    killActiveProcessGroup("SIGTERM");
  }
  cleanupAll();
  if (fs.existsSync(premergeTmpRoot)) {
    shutdown.cleanupPremergeTmpRoot();
  }
});

process.on("unhandledRejection", (reason) => {
  if (shutdown?.shuttingDown) {
    void shutdown.drainPendingSigint().then(() => {
      exitPremerge(shutdown.shutdownExitCode ?? 130);
    });
    return;
  }
  console.error(reason);
  cleanupAll();
  if (!shutdown.cleanupPremergeTmpRoot()) {
    process.exit(1);
  }
  process.exit(1);
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

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 * @param {{ allowFailure?: boolean }} [opts]
 */
async function runLeg(cmd, args, env = {}, cwd = sdkRoot, opts = {}) {
  try {
    return await shutdown.run(cmd, args, premergeChildEnv(env), cwd, opts);
  } catch (error) {
    if (shutdown.shuttingDown) {
      await shutdown.drainPendingSigint();
      exitPremerge(shutdown.shutdownExitCode ?? 130);
    }
    throw error;
  }
}

async function main() {
  const nodeParts = parseNodeVersionParts(process.version);
  if (!nodeParts || !isNodeVersionAtLeast(nodeParts, PREMERGE_MIN_NODE)) {
    await fail(
      `premerge requires Node >=${PREMERGE_MIN_NODE.join(".")} (current ${process.version}). See apps/js-sdk/package.json engines.`,
    );
  }

  const allowDirty = process.env.IC_PREMERGE_ALLOW_DIRTY === "1";
  if (!allowDirty) {
    try {
      assertGitTreeClean(repoRoot);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** @type {string} */
  let head;
  try {
    head = assertExpectedShaMatchesHead(repoRoot, process.env.EXPECTED_SHA);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }

  try {
    assertPremergeRejectsAllowLibTestEnv(process.env);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }

  const skipLegs = process.env.IC_PREMERGE_SKIP_LEGS === "1";
  const stopAfter = String(process.env.IC_PREMERGE_STOP_AFTER ?? "");

  if (!skipLegs) {
    await runLeg("npm", ["run", "guard:12"]);
    if (stopAfter === "guard:12") {
      exitPremerge(0);
    }
    await runLeg("node", ["scripts/check-lib-no-test-env.mjs"]);
    if (stopAfter === "check-lib") {
      exitPremerge(0);
    }
    loadApiEnvFile();
    for (const key of ["SYNC_E2E_DATABASE_URL", "VAULT_E2E_DATABASE_URL"]) {
      delete process.env[key];
    }
    try {
      assertPremergePostgresUrlsSafe(process.env);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
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
      await fail(error instanceof Error ? error.message : String(error));
    }

    await runLeg("pnpm", ["-r", "check"], {}, repoRoot);
    if (stopAfter === "pnpm-check") {
      exitPremerge(0);
    }

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
      await runLeg("npm", ["run", "storage:emu:up"], emuComposeEnv);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    }

    try {
      assertPremergeExpectedPackagesDefineTestScript(repoRoot);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    }
  }

  const icTmpBeforeTests = listAllIcTmpDirs(premergeTmpRoot);
  const nodePtyLoadable = isNodePtyLoadable(sdkRoot);
  warnIfNodePtyMissing(sdkRoot);

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

  let testOut = "";
  let testRunFailed = false;
  const probe = String(process.env.IC_PREMERGE_PROBE ?? "");
  if (skipLegs && probe) {
    testOut = premergeProbeTestOutput(probe);
  } else if (!skipLegs) {
    try {
      testOut = await runLeg(
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
        await shutdown.finalizeTmpHygiene(icTmpBeforeTests);
      }
    }

    await shutdown.drainPendingSigint();

    if (testRunFailed && !shutdown.shuttingDown) {
      exitPremerge(1);
    }

    if (shutdown.shuttingDown) {
      exitPremerge(shutdown.shutdownExitCode ?? 130);
    }
  } else if (skipLegs) {
    testOut = premergeProbeTestOutput("ok");
  }

  const parsed = absorbNodeTestTotals(testOut);
  totals.pass = parsed.pass;
  totals.fail = parsed.fail;
  totals.skipped = parsed.skipped;
  totals.tests = parsed.tests;

  try {
    if (!(skipLegs && probe === "floor-violation")) {
      assertPremergeTestTotalsValid({ ...totals, blocks: parsed.blocks });
    }
    assertPremergePackageTestSections(testOut, { nodePtyLoadable });
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }

  if (process.env.IC_PREMERGE_PROBE === "expected-sha-mismatch") {
    process.env.EXPECTED_SHA = "0".repeat(40);
  }

  try {
    head = assertExpectedShaMatchesHead(repoRoot, process.env.EXPECTED_SHA);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
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
    let floor = PREMERGE_PACKAGE_MIN_PASS[name];
    if (name === "infinitecontext") {
      floor = infinitecontextMinPassFloor(nodePtyLoadable);
    }
    const floorLabel = floor !== undefined ? ` floor ${floor}` : "";
    console.log(
      `    ${name}: pass ${row.pass}, fail ${row.fail}, skipped ${row.skipped}, tests ${row.tests} (${row.blocks} block(s))${floorLabel}`,
    );
  }

  if (totals.fail > 0) {
    await shutdown.drainPendingSigint();
    exitPremerge(1);
  }

  exitPremerge(0);
}

main().catch(async (error) => {
  if (shutdown?.shuttingDown) {
    await shutdown.drainPendingSigint();
    exitPremerge(shutdown.shutdownExitCode ?? 130);
    return;
  }
  console.error(error);
  cleanupAll();
  if (!shutdown.cleanupPremergeTmpRoot()) {
    process.exit(1);
  }
  process.exit(1);
});
