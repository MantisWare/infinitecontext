#!/usr/bin/env node
/**
 * Detached cwd holder under premerge TMPDIR (outside active leg tree).
 * Shutdown must kill it via killProcessesUsingPath (S-M6 regression).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m6-path-"));
const pidFile = path.join(os.tmpdir(), `ic-m6-holder-${process.pid}.pid`);

const holderScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "premerge-m6-cwd-holder.mjs");
const holder = spawn(process.execPath, [holderScript, premergeTmpRoot], {
  detached: true,
  stdio: "ignore",
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
});
if (!holder.pid || !holderAlive(holder.pid)) {
  process.exit(3);
}
fs.writeFileSync(pidFile, String(holder.pid));
holder.unref();

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set([premergeTmpRoot]),
});

await new Promise((r) => setTimeout(r, 120));
shutdown.beginShutdown("SIGINT");
shutdown.finishShutdown();
await new Promise((r) => setTimeout(r, 250));

const holderPid = Number(fs.readFileSync(pidFile, "utf8").trim());
try {
  fs.unlinkSync(pidFile);
} catch {
  /* ignore */
}

if (holderAlive(holderPid)) {
  try {
    process.kill(holderPid, "SIGKILL");
  } catch {
    /* ignore */
  }
  process.exit(2);
}
process.exit(130);

/**
 * @param {number} pid
 */
function holderAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
