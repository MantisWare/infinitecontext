import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createPremergeShutdown } from "./premerge-shutdown.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("premerge shutdown M7 skip (S-M7 committed mutant target)", () => {
  it("M7 skips terminateActiveLeg — leg promise settles within timeout (no hang)", async () => {
    const prevMut = process.env.PREMERGE_MUTANT;
    const prevAllow = process.env.IC_PREMERGE_ALLOW_MUTANT;
    process.env.PREMERGE_MUTANT = "M7";
    process.env.IC_PREMERGE_ALLOW_MUTANT = "1";
    const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sm7-skip-"));
    try {
      const shutdown = createPremergeShutdown({
        premergeTmpRoot,
        cleanupAll: () => {},
        killActiveProcessGroup: () => {},
        assertNoNewIcTmpDirLeaks: () => {},
        listAllIcTmpDirs: () => new Set(),
      });
      const legPromise = shutdown
        .run(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], process.env, sdkRoot)
        .catch(() => "");
      await new Promise((r) => setTimeout(r, 150));
      const legPid = shutdown.activeChild?.pid;
      await Promise.race([
        shutdown.terminateActiveLeg("SIGTERM"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("terminateActiveLeg hung")), 5000)),
      ]);
      if (legPid) {
        try {
          process.kill(legPid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      await Promise.race([legPromise, new Promise((r) => setTimeout(r, 2000))]);
    } finally {
      if (prevAllow === undefined) {
        delete process.env.IC_PREMERGE_ALLOW_MUTANT;
      } else {
        process.env.IC_PREMERGE_ALLOW_MUTANT = prevAllow;
      }
      if (prevMut === undefined) {
        delete process.env.PREMERGE_MUTANT;
      } else {
        process.env.PREMERGE_MUTANT = prevMut;
      }
      fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
    }
  });
});
