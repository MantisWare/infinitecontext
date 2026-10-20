#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPremergeShutdown, drainPendingSigint } from "../../../scripts/premerge-shutdown.mjs";

const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m3-probe-"));
const shutdown = createPremergeShutdown({
  premergeTmpRoot,
  cleanupAll: () => {},
  killActiveProcessGroup: () => {},
  assertNoNewIcTmpDirLeaks: () => {},
  listAllIcTmpDirs: () => new Set(),
});

shutdown.beginShutdown("SIGINT");
await drainPendingSigint();
shutdown.exitPremerge(1);
