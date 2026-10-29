#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m7-probe-"));
const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set(),
});

void shutdown.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, process.cwd());
await new Promise((r) => setTimeout(r, 300));
await shutdown.terminateActiveLeg("SIGKILL");
await new Promise((r) => setTimeout(r, 200));
const alive = shutdown.activeChild?.pid && (() => {
  try {
    process.kill(shutdown.activeChild.pid, 0);
    return true;
  } catch {
    return false;
  }
})();
console.log(alive ? "CHILD_ALIVE" : "CHILD_GONE");
const legPid = shutdown.activeChild?.pid;
if (legPid) {
  try {
    process.kill(legPid, "SIGKILL");
  } catch {
    /* ignore */
  }
}
try {
  fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(0);
