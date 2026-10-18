#!/usr/bin/env node
/**
 * Minimal repro of premerge SIGINT during pnpm test (api step): must exit 130,
 * remove private TMPDIR, and never print temp-dir leak errors.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoNewIcTmpDirLeaks,
  listAllIcTmpDirs,
} from "../../../scripts/premerge-lib.mjs";
import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const tag = `ic-premerge-sigint-race-${process.pid}`;
const callerTmp = path.resolve(process.env.TMPDIR ?? os.tmpdir());
const premergeTmpRoot = fs.mkdtempSync(path.join(callerTmp, `${tag}-tmpdir-`));
process.env.TMPDIR = premergeTmpRoot;
process.env.IC_PREMERGE_TMPDIR = premergeTmpRoot;

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup(signal) {
    const child = shutdown.activeChild;
    if (!child?.pid) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  },
  assertNoNewIcTmpDirLeaks,
  listAllIcTmpDirs: () => listAllIcTmpDirs(premergeTmpRoot),
});

shutdown.registerSignalHandlers();

const icTmpBeforeTests = listAllIcTmpDirs(premergeTmpRoot);
const ready = path.join(premergeTmpRoot, "child-ready.txt");

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const sleeper = path.join(fixtureDir, "premerge-sigint-sleeper.mjs");

let testRunFailed = false;
try {
  await shutdown.run(process.execPath, [sleeper, ready], {}, fixtureDir, { allowFailure: true });
} catch {
  if (!shutdown.shuttingDown) {
    testRunFailed = true;
  }
} finally {
  if (!shutdown.shuttingDown) {
    shutdown.finalizeTmpHygiene(icTmpBeforeTests);
  }
}

if (testRunFailed && !shutdown.shuttingDown) {
  shutdown.exitPremerge(1);
}

shutdown.exitPremerge(0);
