import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const raceFixture = path.join(sdkRoot, "tests/storage/fixtures/premerge-sigint-race.mjs");

/**
 * @param {number} timeoutMs
 */
function waitForReadyInPrivateTmp(timeoutMs = 15_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (!name.startsWith("ic-premerge-sigint-race-") || !name.includes("-tmpdir-")) {
          continue;
        }
        const full = path.join(os.tmpdir(), name);
        const readyFile = path.join(full, "child-ready.txt");
        try {
          if (fs.readFileSync(readyFile, "utf8").includes("ready")) {
            resolve(full);
            return;
          }
        } catch {
          /* not ready */
        }
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("premerge sigint race fixture ready marker not found"));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
}

describe("premerge SIGINT during test step", () => {
  it("exits 130, removes private TMPDIR, and does not report temp-dir leaks", async () => {
    /** @type {string} */
    let privateTmp = "";
    let stderr = "";
    const child = spawn(process.execPath, [raceFixture], {
      cwd: sdkRoot,
      env: { ...process.env, TMPDIR: os.tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    privateTmp = await waitForReadyInPrivateTmp();
    assert.ok(privateTmp.includes("ic-premerge-sigint-race-"), privateTmp);
    child.kill("SIGINT");
    const exitCode = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    assert.equal(exitCode, 130);
    assert.doesNotMatch(stderr, /left new temp directories/);
    assert.equal(fs.existsSync(privateTmp), false);
  });
});
