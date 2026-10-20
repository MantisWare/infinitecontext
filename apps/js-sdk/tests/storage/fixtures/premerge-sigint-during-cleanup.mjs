#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sigint-cleanup-"));

const slowCleanup = () => {
  console.log("CLEANUP_STARTED");
  spawnSync("sleep", ["3"], { stdio: "ignore" });
};

/** @type {ReturnType<typeof createPremergeShutdown>} */
let shutdown;
shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: slowCleanup,
  killActiveProcessGroup(signal) {
    void shutdown.terminateActiveLeg(signal);
  },
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set(),
});

shutdown.registerSignalHandlers();

let testRunFailed = false;
try {
  await shutdown.run(process.execPath, ["-e", "process.exit(1)"], {}, process.cwd(), { allowFailure: true });
} catch {
  if (!shutdown.shuttingDown) {
    testRunFailed = true;
  }
} finally {
  slowCleanup();
}

await shutdown.drainPendingSigint();

if (testRunFailed && !shutdown.shuttingDown) {
  shutdown.exitPremerge(1);
}
if (shutdown.shuttingDown) {
  shutdown.exitPremerge(shutdown.shutdownExitCode ?? 130);
}
shutdown.exitPremerge(0);
