import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createPremergeShutdown } from "./premerge-shutdown.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("premerge shutdown process-group kill order", () => {
  it("terminateActiveLeg sends kill(-pgid) before per-pid walk (M1b dies structurally)", async () => {
    const prevMut = process.env.PREMERGE_MUTANT;
    delete process.env.PREMERGE_MUTANT;
    /** @type {{ pid: number, sig: import("node:child_process").Signal }[]} */
    const kills = [];
    const killProcess = (pid, sig) => {
      kills.push({ pid, sig });
      try {
        return process.kill(pid, sig);
      } catch {
        return false;
      }
    };
    const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-group-kill-"));
    const shutdown = createPremergeShutdown({
      premergeTmpRoot,
      cleanupAll: () => {},
      killActiveProcessGroup: () => {},
      assertNoNewIcTmpDirLeaks: () => {},
      listAllIcTmpDirs: () => new Set(),
      killProcess,
    });

    const legPromise = shutdown
      .run(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {}, sdkRoot)
      .catch(() => "");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(shutdown.activeChild?.pid);
    await shutdown.terminateActiveLeg("SIGTERM");

    const negIdx = kills.findIndex((k) => k.pid < 0);
    const posTermIdx = kills.findIndex((k) => k.pid > 0 && k.sig === "SIGTERM");
    assert.ok(negIdx >= 0, "expected process-group kill(-pgid)");
    assert.ok(posTermIdx < 0 || negIdx < posTermIdx, "group kill must precede per-pid SIGTERM");

    await legPromise;
    fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
    if (prevMut === undefined) {
      delete process.env.PREMERGE_MUTANT;
    } else {
      process.env.PREMERGE_MUTANT = prevMut;
    }
  });

  it("PREMERGE_MUTANT=M1b skips process-group kill (mutant only)", async () => {
    /** @type {{ pid: number, sig: import("node:child_process").Signal }[]} */
    const kills = [];
    const killProcess = (pid, sig) => {
      kills.push({ pid, sig });
      try {
        return process.kill(pid, sig);
      } catch {
        return false;
      }
    };
    const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m1b-group-"));
    const prevMut = process.env.PREMERGE_MUTANT;
    process.env.PREMERGE_MUTANT = "M1b";
    try {
      const shutdown = createPremergeShutdown({
        premergeTmpRoot,
        cleanupAll: () => {},
        killActiveProcessGroup: () => {},
        assertNoNewIcTmpDirLeaks: () => {},
        listAllIcTmpDirs: () => new Set(),
        killProcess,
      });
      const legPromise = shutdown
        .run(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {}, sdkRoot)
        .catch(() => "");
      await new Promise((r) => setTimeout(r, 150));
      const legPid = shutdown.activeChild?.pid;
      await shutdown.terminateActiveLeg("SIGTERM");
      assert.equal(
        kills.some((k) => k.pid < 0),
        false,
        "M1b must not call kill(-pgid)",
      );
      if (legPid) {
        try {
          process.kill(legPid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      await Promise.race([legPromise, new Promise((r) => setTimeout(r, 500))]);
    } finally {
      if (prevMut === undefined) {
        delete process.env.PREMERGE_MUTANT;
      } else {
        process.env.PREMERGE_MUTANT = prevMut;
      }
      fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
    }
  });
});
