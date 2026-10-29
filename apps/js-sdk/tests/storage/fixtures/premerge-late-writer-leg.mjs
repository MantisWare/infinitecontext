#!/usr/bin/env node
/**
 * Simulates a pnpm test leg that exits while detached workers keep writing under TMPDIR.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const tag = `ic-late-writer-${process.pid}`;
const callerTmp = path.resolve(process.env.TMPDIR ?? os.tmpdir());
const premergeTmpRoot = process.env.IC_PREMERGE_TMPDIR ?? fs.mkdtempSync(path.join(callerTmp, `${tag}-tmpdir-`));
process.env.TMPDIR = premergeTmpRoot;
process.env.IC_PREMERGE_TMPDIR = premergeTmpRoot;

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(fixtureDir, "premerge-late-writer-worker.mjs");

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

console.log("LATE_WRITER_LEG_READY");

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
