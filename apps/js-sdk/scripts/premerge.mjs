import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  PREMERGE_MIN_NODE,
  absorbNodeTestTotals,
  assertExpectedShaMatchesHead,
  assertGitTreeClean,
  isNodeVersionAtLeast,
  parseNodeVersionParts,
  resolveRepoRootsFromImportMeta,
} from "./premerge-lib.mjs";

const { sdkRoot, repoRoot } = resolveRepoRootsFromImportMeta(import.meta.url);

/** @type {{ pass: number, fail: number, skipped: number, tests: number }} */
const totals = { pass: 0, fail: 0, skipped: 0, tests: 0 };

/** @type {0 | 1 | 2 | 130 | 143} */
let exitCode = 0;

let emuStarted = false;
let cleaning = false;

function fail(message, code = 1) {
  console.error(message);
  exitCode = code;
  cleanupEmu();
  process.exit(code);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 */
function run(cmd, args, env, cwd = sdkRoot) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.stdout) {
    process.stdout.write(res.stdout);
  }
  if (res.stderr) {
    process.stderr.write(res.stderr);
  }
  if (res.status !== 0) {
    exitCode = res.status ?? 1;
    cleanupEmu();
    process.exit(exitCode);
  }
  return out;
}

function cleanupEmu() {
  if (cleaning) {
    return;
  }
  cleaning = true;
  if (!emuStarted) {
    return;
  }
  spawnSync("npm", ["run", "storage:emu:down"], { cwd: sdkRoot, stdio: "inherit" });
  emuStarted = false;
}

function onSignal(signal) {
  exitCode = signal === "SIGINT" ? 130 : 143;
  cleanupEmu();
  process.exit(exitCode);
}

process.on("exit", () => {
  cleanupEmu();
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

let head;
try {
  head = assertExpectedShaMatchesHead(repoRoot, process.env.EXPECTED_SHA);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

run("npm", ["run", "guard:12"]);
run("node", ["scripts/check-lib-no-test-env.mjs"]);
run("pnpm", ["-r", "check"], {}, repoRoot);

console.log("premerge: starting storage emulator (MinIO + SFTP)…");
run("npm", ["run", "storage:emu:up"]);
emuStarted = true;

const emuEnv = {
  IC_REQUIRE_MINIO: "1",
  AWS_ACCESS_KEY_ID: "minioadmin",
  AWS_SECRET_ACCESS_KEY: "minioadmin",
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT_URL: "http://127.0.0.1:9000",
  INFINITECONTEXT_S3_TEST_BUCKET: "infinitecontext-ci",
  INFINITECONTEXT_S3_TEST_PREFIX: "premerge-local",
};

function mergeTotals(chunk) {
  totals.pass += chunk.pass;
  totals.fail += chunk.fail;
  totals.skipped += chunk.skipped;
  totals.tests += chunk.tests;
}

mergeTotals(
  absorbNodeTestTotals(
    run("pnpm", ["-r", "--workspace-concurrency=1", "test"], emuEnv, repoRoot),
  ),
);

cleanupEmu();

console.log("");
console.log("premerge summary:");
console.log(`  pass: ${totals.pass}`);
console.log(`  fail: ${totals.fail}`);
console.log(`  skipped: ${totals.skipped}`);
console.log(`  tests: ${totals.tests}`);
console.log(`  HEAD: ${head}`);
