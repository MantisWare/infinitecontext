#!/usr/bin/env node
/**
 * Deterministic B1 ordering: leg exits 1, SIGINT scheduled on same tick after close enters.
 * IC_PREMERGE_FIXTURE_SIMULATE_B1_REVERT=1 skips drainPendingSigint (simulates reverted 55b8e33 hunk).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-b1-race-"));

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set([premergeTmpRoot]),
  testHooks: {
    scheduleSigintOnLegFailureClose: true,
    skipDrainPendingSigintOnLegFailure:
      String(process.env.IC_PREMERGE_FIXTURE_SIMULATE_B1_REVERT ?? "").trim() === "1",
  },
});

shutdown.registerSignalHandlers();

try {
  await shutdown.run(process.execPath, ["-e", "process.exit(1)"], {}, process.cwd());
} catch {
  if (shutdown.shuttingDown) {
    shutdown.exitPremerge(shutdown.shutdownExitCode ?? 130);
  }
  process.exit(1);
}
process.exit(0);
