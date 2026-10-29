#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pnpm-check-sigint-"));

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set(),
});

shutdown.registerSignalHandlers();

console.log("premerge: starting pnpm -r check…");
console.log("PNPM_CHECK_LEG_READY");
try {
  await shutdown.run("bash", ["-c", "sleep 0.08; exit 1"], {}, process.cwd());
} catch {
  if (shutdown.shuttingDown) {
    shutdown.exitPremerge(shutdown.shutdownExitCode ?? 130);
  }
  process.exit(1);
}
process.exit(0);
