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
const premergeTmpRoot = process.env.IC_PREMERGE_TMPDIR ?? fs.mkdtempSync(path.join(callerTmp, `${tag}-tmpdir-`));
process.env.TMPDIR = premergeTmpRoot;
process.env.IC_PREMERGE_TMPDIR = premergeTmpRoot;

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(fixtureDir, "premerge-m1b-orphan-fd-worker.mjs");

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

console.log("ORPHAN_FD_LEG_READY");

try {
  await shutdown.run(process.execPath, [worker], {}, fixtureDir);
} catch {
  if (!shutdown.shuttingDown) {
    shutdown.exitPremerge(1);
  }
}

if (!shutdown.shuttingDown) {
  shutdown.exitPremerge(0);
}
