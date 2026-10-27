#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-block-cleanup-"));

const slowCleanup = () => {
  console.log("BLOCKING_CLEANUP_STARTED");
  const until = Date.now() + 3000;
  while (Date.now() < until && !shutdown?.shuttingDown) {
    spawnSync("sleep", ["0.05"], { stdio: "ignore" });
  }
};

/** @type {ReturnType<typeof createPremergeShutdown>} */
let shutdown;
shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: slowCleanup,
  killActiveProcessGroup: () => {},
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
