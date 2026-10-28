#!/usr/bin/env node
/**
 * Real-shell proofs for SKIP_LEGS / STOP_AFTER / inherited mutant env / probe values.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
const head = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
const password = fs.readFileSync(`${repoRoot}/apps/postgres/.env`, "utf8").match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1]?.trim() ?? "";

/** @type {string[]} */
const failures = [];

/**
 * @param {Record<string, string>} env
 */
function runPremerge(env) {
  return spawnSync(process.execPath, ["scripts/premerge.mjs"], {
    cwd: sdkRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SHA: head,
      POSTGRES_PASSWORD: password,
      ...env,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function assertNoGreenSummary(label, res) {
  const combined = `${res.stdout}\n${res.stderr}`;
  if (res.status === 0) {
    failures.push(`${label}: expected non-zero exit, got 0`);
  }
  if (/premerge summary:/.test(combined) && !/SYNTHETIC/.test(combined)) {
    failures.push(`${label}: green premerge summary without SYNTHETIC`);
  }
}

console.log("=== SKIP_LEGS probe loop (expect 92 + SYNTHETIC, never green summary) ===");
for (const probe of ["x", "", "green", "floor-violation", "garbage-probe"]) {
  const res = runPremerge({
    IC_PREMERGE_ALLOW_DIRTY: "1",
    IC_PREMERGE_SKIP_LEGS: "1",
    IC_PREMERGE_ALLOW_SKIP_LEGS: "1",
    IC_PREMERGE_PROBE: probe,
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  console.log(`probe=${JSON.stringify(probe)} rc=${res.status}`);
  if (res.status === 0) {
    failures.push(`probe ${probe}: expected non-zero exit, got 0`);
  }
  if (probe === "green" || probe === "floor-violation") {
    if (res.status !== 92) {
      failures.push(`probe ${probe}: expected rc 92, got ${res.status}`);
    }
    if (!/SYNTHETIC/.test(combined)) {
      failures.push(`probe ${probe}: missing SYNTHETIC line`);
    }
  }
  if ((probe === "x" || probe === "garbage-probe" || probe === "") && /premerge summary:/.test(combined)) {
    failures.push(`probe ${probe}: must not print green premerge summary`);
  }
  assertNoGreenSummary(`skip-legs probe=${probe}`, res);
}

console.log("\n=== STOP_AFTER guard:12 (expect 92 partial) ===");
const stop = runPremerge({
  IC_PREMERGE_ALLOW_DIRTY: "1",
  IC_PREMERGE_STOP_AFTER: "guard:12",
  IC_PREMERGE_ALLOW_STOP_AFTER: "1",
});
console.log("rc", stop.status);
assertNoGreenSummary("stop-after", stop);
if (stop.status !== 92) {
  failures.push(`STOP_AFTER: expected 92, got ${stop.status}`);
}

console.log("\n=== inherited PREMERGE_MUTANT=M3 without allow (must refuse start) ===");
const inherited = runPremerge({
  IC_PREMERGE_ALLOW_DIRTY: "1",
  PREMERGE_MUTANT: "M3",
});
console.log("rc", inherited.status);
console.log((inherited.stdout + inherited.stderr).slice(-500));
if (inherited.status === 0) {
  failures.push("inherited M3: must not exit 0");
}
if (!/refuses inherited mutant/.test(`${inherited.stdout}\n${inherited.stderr}`)) {
  failures.push("inherited M3: missing refuse message");
}

console.log("\n=== inherited IC_PREMERGE_ALLOW_MUTANT=1 + PREMERGE_MUTANT=M6 (must refuse) ===");
const inheritedAllow = runPremerge({
  IC_PREMERGE_ALLOW_DIRTY: "1",
  IC_PREMERGE_ALLOW_MUTANT: "1",
  PREMERGE_MUTANT: "M6",
});
console.log("rc", inheritedAllow.status);
if (inheritedAllow.status === 0) {
  failures.push("inherited allow+M6: must not exit 0");
}
const allowCombined = `${inheritedAllow.stdout}\n${inheritedAllow.stderr}`;
if (!/refuses inherited mutant|refuses IC_PREMERGE_ALLOW_MUTANT/.test(allowCombined)) {
  failures.push("inherited allow+M6: missing refuse message");
}

if (failures.length > 0) {
  console.error("\nSHELL PROOFS FAILED:");
  for (const f of failures) {
    console.error(" -", f);
  }
  process.exit(1);
}
console.log("\nSHELL PROOFS OK");
