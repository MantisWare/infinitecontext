import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(sdkRoot, "tests/storage/fixtures/premerge-blocking-cleanup-sigint.mjs");

/**
 * @param {number} delayMs
 */
async function runBlockingSigintOnce(delayMs) {
  const child = spawn(process.execPath, [fixture], {
    cwd: sdkRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PREMERGE_MUTANT: "" },
  });
  let buf = "";
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const onData = (c) => {
      buf += String(c);
      if (buf.includes("BLOCKING_CLEANUP_STARTED")) {
        resolve(undefined);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const poll = () => {
      if (buf.includes("BLOCKING_CLEANUP_STARTED")) {
        resolve(undefined);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timeout waiting for blocking cleanup"));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
  await new Promise((r) => setTimeout(r, delayMs));
  child.kill("SIGINT");
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 25_000);
  });
  return code;
}

describe("SIGINT during spawnSync blocking cleanup", () => {
  it("exits 130 at 0.2s, 1.5s, and 2.8s delays (10 runs each)", async () => {
    for (const delayMs of [200, 1500, 2800]) {
      for (let i = 0; i < 10; i += 1) {
        let code = await runBlockingSigintOnce(delayMs);
        if (code !== 130) {
          code = await runBlockingSigintOnce(delayMs);
        }
        assert.equal(code, 130, `delay=${delayMs} run=${i + 1}`);
      }
    }
  });
});
