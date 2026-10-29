import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createPremergeShutdown } from "./premerge-shutdown.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("premerge shutdown M7 skip (S-M7 committed mutant target)", () => {
  it("terminateActiveLeg kills the active leg (sm7 must not no-op all shutdown)", async () => {
    const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sm7-skip-"));
    /** @type {number | undefined} */
    let legPid;
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
      legPid = shutdown.activeChild?.pid;
      assert.ok(legPid);
      await shutdown.terminateActiveLeg("SIGTERM");
      await Promise.race([legPromise, new Promise((r) => setTimeout(r, 3000))]);
      try {
        process.kill(legPid, 0);
        assert.fail("expected leg pid to be dead after terminateActiveLeg");
      } catch (err) {
        assert.ok(err && typeof err === "object" && "code" in err && err.code === "ESRCH");
      }
    } finally {
      if (legPid) {
        try {
          process.kill(legPid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
    }
  });
});
