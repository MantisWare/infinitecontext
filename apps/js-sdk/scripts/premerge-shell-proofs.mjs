#!/usr/bin/env node
/**
 * Real-shell proofs for SKIP_LEGS / STOP_AFTER / inherited PREMERGE_MUTANT (no test runner).
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
      PREMERGE_MUTANT: "",
      ...env,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

console.log("=== SKIP_LEGS allow+probe (expect 92 SYNTHETIC, no summary success) ===");
const skip = runPremerge({
  IC_PREMERGE_ALLOW_DIRTY: "1",
  IC_PREMERGE_SKIP_LEGS: "1",
  IC_PREMERGE_ALLOW_SKIP_LEGS: "1",
  IC_PREMERGE_PROBE: "green",
});
console.log("rc", skip.status);
console.log((skip.stdout + skip.stderr).slice(-800));

console.log("\n=== STOP_AFTER guard:12 (expect 92 partial) ===");
const stop = runPremerge({
  IC_PREMERGE_ALLOW_DIRTY: "1",
  IC_PREMERGE_STOP_AFTER: "guard:12",
  IC_PREMERGE_ALLOW_STOP_AFTER: "1",
});
console.log("rc", stop.status);
console.log((stop.stdout + stop.stderr).slice(-800));

console.log("\n=== inherited PREMERGE_MUTANT=M3 without allow (real premerge, SIGINT at guard) ===");
const { spawn } = await import("node:child_process");
const child = spawn(process.execPath, ["scripts/premerge.mjs"], {
  cwd: sdkRoot,
  env: {
    ...process.env,
    EXPECTED_SHA: head,
    POSTGRES_PASSWORD: password,
    PREMERGE_MUTANT: "M3",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 120_000;
  const onData = (c) => {
    log += String(c);
    if (/guard:12|check-12-paths/.test(log)) {
      resolve(undefined);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const poll = () => {
    if (/guard:12|check-12-paths/.test(log)) {
      resolve(undefined);
      return;
    }
    if (Date.now() > deadline) {
      reject(new Error("timeout"));
      return;
    }
    setImmediate(poll);
  };
  poll();
});
child.kill("SIGINT");
const inheritedRc = await new Promise((r) => child.on("exit", (c) => r(c)));
const tmp = /premerge: private TMPDIR=(\S+)/.exec(log)?.[1];
console.log("rc", inheritedRc, "tmpLeft", tmp ? fs.existsSync(tmp) : "n/a");
console.log("log tail", log.slice(-400));
