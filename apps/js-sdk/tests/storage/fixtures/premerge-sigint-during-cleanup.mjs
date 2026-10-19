#!/usr/bin/env node
/**
 * Mimics premerge after a failing pnpm test: finally runs slow cleanupAll; SIGINT must still exit 130.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sigint-cleanup-"));
const marker = path.join(premergeTmpRoot, "cleanup-started.txt");

/** @type {ReturnType<typeof createPremergeShutdown>} */
let shutdown;

const slowCleanup = async () => {
  fs.writeFileSync(marker, "started\n");
  console.log("CLEANUP_STARTED");
  for (let i = 0; i < 150; i += 1) {
    if (shutdown.shuttingDown) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {
    /* sync entry unused; premerge calls cleanup in finally directly */
  },
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
  await slowCleanup();
}

await new Promise((resolve) => setImmediate(resolve));

if (testRunFailed && !shutdown.shuttingDown) {
  shutdown.exitPremerge(1);
}
if (shutdown.shuttingDown) {
  shutdown.exitPremerge(shutdown.shutdownExitCode ?? 130);
}
shutdown.exitPremerge(0);
