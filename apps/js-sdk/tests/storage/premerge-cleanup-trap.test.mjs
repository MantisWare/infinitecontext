import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trapChild = path.join(sdkRoot, "tests/storage/fixtures/premerge-trap-child.mjs");
const trapProcessGroup = path.join(sdkRoot, "tests/storage/fixtures/premerge-trap-process-group.mjs");
const trapSleeper = path.join(sdkRoot, "tests/storage/fixtures/premerge-trap-sleeper.mjs");

/**
 * @param {string} readyPath
 * @param {number} timeoutMs
 */
function waitForReadyFile(readyPath, timeoutMs = 10_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (fs.readFileSync(readyPath, "utf8").includes("ready")) {
          resolve();
          return;
        }
      } catch {
        /* not yet */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`child ready marker not seen: ${readyPath}`));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
}

/**
 * @param {"SIGINT" | "SIGTERM"} signal
 * @param {number} expectedCode
 */
async function runTrapChildSignalTest(signal, expectedCode) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = path.join(os.tmpdir(), `ic-premerge-trap-${stamp}.txt`);
  const ready = path.join(os.tmpdir(), `ic-premerge-trap-${stamp}.ready`);
  const child = spawn(process.execPath, [trapChild], {
    env: { ...process.env, PREMERGE_TRAP_MARKER: marker, PREMERGE_TRAP_READY: ready },
    stdio: "ignore",
  });
  await waitForReadyFile(ready);
  child.kill(signal);
  const code = await new Promise((resolve) => {
    child.on("exit", (status) => resolve(status));
  });
  assert.equal(code, expectedCode);
  assert.equal(fs.readFileSync(marker, "utf8"), "down\n");
  fs.unlinkSync(marker);
  try {
    fs.unlinkSync(ready);
  } catch {
    /* ignore */
  }
  return true;
}

describe("premerge-style cleanup traps", () => {
  it("runs cleanup on SIGINT (exit 130)", async () => {
    await runTrapChildSignalTest("SIGINT", 130);
  });

  it("kills detached grandchild process group on SIGINT", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const marker = path.join(os.tmpdir(), `ic-premerge-trap-pg-${stamp}.txt`);
    const ready = path.join(os.tmpdir(), `ic-premerge-trap-pg-${stamp}.ready`);
    const child = spawn(process.execPath, [trapProcessGroup], {
      env: {
        ...process.env,
        PREMERGE_TRAP_MARKER: marker,
        PREMERGE_TRAP_READY: ready,
        PREMERGE_TRAP_SLEEPER: trapSleeper,
      },
      stdio: "ignore",
      detached: true,
    });
    await waitForReadyFile(ready);
    assert.ok(child.pid);
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
    const code = await new Promise((resolve) => {
      child.on("exit", (status) => resolve(status));
    });
    assert.equal(code, 130);
    assert.equal(fs.readFileSync(marker, "utf8"), "down\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ps = spawnSync("pgrep", ["-f", "[p]remerge-trap-sleeper.mjs"], { encoding: "utf8" });
    assert.equal(String(ps.stdout ?? "").trim(), "", "grandchild sleeper must not outlive SIGINT");
    fs.unlinkSync(marker);
    try {
      fs.unlinkSync(ready);
    } catch {
      /* ignore */
    }
  });

  it("runs cleanup on SIGTERM (exit 143)", async () => {
    await runTrapChildSignalTest("SIGTERM", 143);
  });

  it("SIGINT cleanup stable under parallel load (20 concurrent runs)", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runTrapChildSignalTest("SIGINT", 130)),
    );
    assert.equal(results.length, 20);
    assert.equal(results.filter(Boolean).length, 20);
  });
});
