import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { spawn } from "node:child_process";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orphanFdLeg = path.join(sdkRoot, "tests/storage/fixtures/premerge-m1b-orphan-fd-leg.mjs");

/**
 * @param {number} pid
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("M1b orphan defense (O4)", () => {
  it("orphan pid file lives outside private TMPDIR and orphan is reaped on SIGINT", async () => {
    const callerTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-o4-caller-"));
    const orphanPidFile = path.join(callerTmp, "orphan-outside-tmp.pid");
    assert.ok(!orphanPidFile.startsWith(path.join(callerTmp, "ic-orphan-fd-")));

    const child = spawn(process.execPath, [orphanFdLeg], {
      cwd: sdkRoot,
      env: {
        ...process.env,
        TMPDIR: callerTmp,
        IC_PREMERGE_ORPHAN_PID_FILE: orphanPidFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const onData = (c) => {
        buf += String(c);
        if (buf.includes("ORPHAN_FD_LEG_READY")) {
          resolve(undefined);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const poll = () => {
        if (buf.includes("ORPHAN_FD_LEG_READY")) {
          resolve(undefined);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("ORPHAN_FD_LEG_READY timeout"));
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    await new Promise((r) => setTimeout(r, 250));
    child.kill("SIGINT");
    const exitCode = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));

    let orphanPid = null;
    if (fs.existsSync(orphanPidFile)) {
      orphanPid = Number(fs.readFileSync(orphanPidFile, "utf8").trim());
    }
    assert.ok(orphanPid && orphanPid > 0, "worker must record orphan pid outside TMPDIR");
    assert.notEqual(exitCode, 0);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(processAlive(orphanPid), false, "orphan must be reaped without test-local SIGKILL");
    try {
      fs.unlinkSync(orphanPidFile);
    } catch {
      /* ignore */
    }
    fs.rmSync(callerTmp, { recursive: true, force: true });
  });
});
