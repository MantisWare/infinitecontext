#!/usr/bin/env node
/**
 * Detached process keeps cwd under premerge TMPDIR (outside active leg tree).
 * finishShutdown must kill via killProcessesUsingPath (S-M6 regression).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m6-path-"));

const holder = spawn(
  process.execPath,
  ["-e", `process.chdir(${JSON.stringify(premergeTmpRoot)}); setInterval(()=>{}, 1e9)`],
  { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "" } },
);
holder.unref();

const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set([premergeTmpRoot]),
});

shutdown.registerSignalHandlers();

await new Promise((r) => setTimeout(r, 80));
process.kill(process.pid, "SIGINT");

await new Promise((r) => setTimeout(r, 500));

if (fs.existsSync(premergeTmpRoot)) {
  process.exit(2);
}
process.exit(130);
