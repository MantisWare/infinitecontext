#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orphanFdLeg = path.join(sdkRoot, "tests/storage/fixtures/premerge-m1b-orphan-fd-leg.mjs");

/**
 * @param {number} pid
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const callerTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-o4-caller-"));
const probeHome = fs.mkdtempSync(path.join(callerTmp, "home-"));
const orphanPidFile = path.join(callerTmp, "orphan-outside-tmp.pid");
/** @type {number | null} */
let legPid = null;
/** @type {number | null} */
let orphanPid = null;

/** Env for an isolated O4 leg — must not inherit real premerge private tmp/home. */
function isolatedO4LegEnv() {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const key of [
    "IC_PREMERGE_TMPDIR",
    "IC_PREMERGE_HOME",
    "IC_PREMERGE_VAULT_PID_REGISTRY",
    "IC_PREMERGE_ORPHAN_PID_FILE",
    "IC_TEST_TMP_RUN_TAG",
  ]) {
    delete env[key];
  }
  env.TMPDIR = callerTmp;
  env.TMP = callerTmp;
  env.TEMP = callerTmp;
  env.HOME = probeHome;
  env.IC_PREMERGE_ORPHAN_PID_FILE = orphanPidFile;
  return env;
}

try {
  const child = spawn(process.execPath, [orphanFdLeg], {
    cwd: sdkRoot,
    env: isolatedO4LegEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  legPid = child.pid ?? null;
  let buf = "";
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const onData = (c) => {
      buf += String(c);
      if (buf.includes("ORPHAN_FD_LEG_READY")) {
        resolve(undefined);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const poll = () => {
      if (buf.includes("ORPHAN_FD_LEG_READY")) {
        resolve(undefined);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("ORPHAN_FD_LEG_READY timeout"));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
  assert.ok(fs.existsSync(orphanPidFile), "orphan pid file must exist outside private tmp subdir");
  orphanPid = Number(fs.readFileSync(orphanPidFile, "utf8").trim());
  assert.ok(orphanPid && orphanPid > 0, "worker must record orphan pid outside TMPDIR");
  assert.ok(
    !path.dirname(orphanPidFile).startsWith(path.join(callerTmp, "ic-orphan-fd-")),
    "pid file must not live under the private premerge tmp subdir",
  );

  child.kill("SIGINT");
  await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));

  const reapDeadline = Date.now() + 8000;
  while (orphanPid && processAlive(orphanPid) && Date.now() < reapDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    processAlive(orphanPid),
    false,
    "orphan must be reaped by shutdown (hint pid + path kill)",
  );
} finally {
  if (orphanPid && orphanPid > 0) {
    try {
      process.kill(orphanPid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (legPid && legPid > 0) {
    try {
      process.kill(legPid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(orphanPidFile);
  } catch {
    /* ignore */
  }
  fs.rmSync(callerTmp, { recursive: true, force: true });
}
