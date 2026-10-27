#!/usr/bin/env node
/**
 * B1 race probe: leg exits 1 at 300 ms; SIGINT at 300 + PREMERGE_TEST_B1_SIGINT_OFFSET_MS.
 * Head must exit 130 for offsets −60…+450 ms; reverted drain must exit 1 for offsets ≥ +5 ms.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const LEG_FAIL_MS = 300;
const offsetMs = Number(process.env.PREMERGE_TEST_B1_SIGINT_OFFSET_MS ?? 0);
const fireAtMs = LEG_FAIL_MS + offsetMs;

const tmpBase = path.resolve(process.env.IC_PREMERGE_TMPDIR ?? process.env.TMPDIR ?? os.tmpdir());
const premergeTmpRoot = fs.mkdtempSync(path.join(tmpBase, "ic-b1-offset-"));

function cleanupTmp() {
  try {
    if (fs.existsSync(premergeTmpRoot)) {
      fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

if (offsetMs > 0) {
  process.env.PREMERGE_TEST_B1_SIGINT_DELAY_MS = String(offsetMs);
}

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set([premergeTmpRoot]),
  testHooks: { scheduleSigintOnLegFailureClose: offsetMs >= 0 },
});

shutdown.registerSignalHandlers();

if (offsetMs < 0) {
  setTimeout(() => {
    try {
      process.kill(process.pid, "SIGINT");
    } catch {
      /* ignore */
    }
  }, fireAtMs);
}

const legScript = `setTimeout(()=>process.exit(1), ${LEG_FAIL_MS})`;

try {
  await shutdown.run(process.execPath, ["-e", legScript], {}, process.cwd());
  cleanupTmp();
  process.exit(0);
} catch {
  if (shutdown.shuttingDown) {
    shutdown.exitPremerge(shutdown.shutdownExitCode ?? 130);
  }
  cleanupTmp();
  process.exit(1);
}
