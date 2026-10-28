#!/usr/bin/env node
/**
 * Leg that exits while a detached orphan keeps an open fd under TMPDIR (no cwd/env probe match).
 * Used to stress M1b (skip process-group kill) vs per-PID walk + killProcessesUsingPath.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const tag = `ic-orphan-fd-${process.pid}`;
const callerTmp = path.resolve(process.env.TMPDIR ?? os.tmpdir());
const inheritedIcTmp = String(process.env.IC_PREMERGE_TMPDIR ?? "").trim();
/** @type {string} */
let premergeTmpRoot;
if (inheritedIcTmp && path.resolve(inheritedIcTmp) === callerTmp) {
  premergeTmpRoot = inheritedIcTmp;
} else {
  if (inheritedIcTmp && path.resolve(inheritedIcTmp) !== callerTmp) {
    delete process.env.IC_PREMERGE_TMPDIR;
  }
  premergeTmpRoot = fs.mkdtempSync(path.join(callerTmp, `${tag}-tmpdir-`));
}
process.env.TMPDIR = premergeTmpRoot;
process.env.IC_PREMERGE_TMPDIR = premergeTmpRoot;

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(fixtureDir, "premerge-m1b-orphan-fd-worker.mjs");
const orphanPidFile =
  String(process.env.IC_PREMERGE_ORPHAN_PID_FILE ?? "").trim() ||
  path.join(callerTmp, `${tag}-orphan.pid`);
process.env.IC_PREMERGE_ORPHAN_PID_FILE = orphanPidFile;

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup(signal) {
    shutdown.terminateActiveLeg(signal);
  },
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set([premergeTmpRoot]),
});

shutdown.registerSignalHandlers();

const legPromise = shutdown
  .run(process.execPath, [worker], {}, fixtureDir)
  .catch(() => {
    if (!shutdown.shuttingDown) {
      shutdown.exitPremerge(1);
    }
  });

const pidDeadline = Date.now() + 15_000;
while (!fs.existsSync(orphanPidFile) && Date.now() < pidDeadline) {
  await new Promise((r) => setTimeout(r, 25));
}
console.log("ORPHAN_FD_LEG_READY");

await legPromise;

if (!shutdown.shuttingDown) {
  shutdown.exitPremerge(0);
}
