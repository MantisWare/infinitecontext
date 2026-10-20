import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const repoRoot = path.resolve(sdkRoot, "../..");
const premerge = path.join(sdkRoot, "scripts/premerge.mjs");

describe("SIGINT during pre-test leg (guard:12)", () => {
  it("exits 130 and removes private TMPDIR", async () => {
    const headProc = spawn("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    let head = "";
    headProc.stdout?.on("data", (c) => {
      head += String(c);
    });
    await new Promise((resolve) => headProc.on("exit", resolve));
    const headSha = head.trim();

    const child = spawn(process.execPath, [premerge], {
      cwd: sdkRoot,
      env: {
        ...process.env,
        EXPECTED_SHA: headSha,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let log = "";
    let tmpDir = "";
    child.stdout?.on("data", (c) => {
      const text = String(c);
      log += text;
      const m = /premerge: private TMPDIR=(\S+)/.exec(text);
      if (m) {
        tmpDir = m[1];
      }
    });
    child.stderr?.on("data", (c) => {
      log += String(c);
    });

    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 120_000;
      const poll = () => {
        if (log.includes("guard:12") || log.includes("check-12-paths")) {
          resolve(undefined);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("guard:12 leg did not start"));
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    child.kill("SIGINT");
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 130);
    assert.ok(tmpDir);
    assert.equal(fs.existsSync(tmpDir), false);
  });
});
