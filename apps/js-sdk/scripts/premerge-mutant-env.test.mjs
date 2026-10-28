import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blockingFixture = path.join(
  sdkRoot,
  "tests/storage/fixtures/premerge-blocking-cleanup-sigint.mjs",
);
const premerge = path.join(sdkRoot, "scripts/premerge.mjs");

describe("premerge production env sanitization", () => {
  it("real premerge refuses inherited PREMERGE_MUTANT without committed-mutant runner", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(sdkRoot, "../.."),
      encoding: "utf8",
    }).stdout.trim();
    const res = spawnSync(process.execPath, [premerge], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SHA: head,
        IC_PREMERGE_ALLOW_DIRTY: "1",
        PREMERGE_MUTANT: "M3",
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /refuses inherited mutant/);
  });

  it("inherited PREMERGE_MUTANT without IC_PREMERGE_ALLOW_MUTANT does not change SIGINT behavior", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [blockingFixture], {
      cwd: sdkRoot,
      env: { ...process.env, PREMERGE_MUTANT: "M1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 20_000;
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
          reject(new Error("timeout"));
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    child.kill("SIGINT");
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 130, "M1 must not apply without IC_PREMERGE_ALLOW_MUTANT");
  });

  it("IC_PREMERGE_SKIP_LEGS with allow+probe exits 92 with SYNTHETIC (not gate pass)", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(sdkRoot, "../.."),
      encoding: "utf8",
    }).stdout.trim();
    const res = spawnSync(process.execPath, [premerge], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SHA: head,
        IC_PREMERGE_ALLOW_DIRTY: "1",
        IC_PREMERGE_SKIP_LEGS: "1",
        IC_PREMERGE_ALLOW_SKIP_LEGS: "1",
        IC_PREMERGE_PROBE: "green",
      },
    });
    assert.equal(res.status, 92);
    assert.match(res.stderr + res.stdout, /SYNTHETIC/);
  });

  it("IC_PREMERGE_STOP_AFTER=guard:12 exits 92 (partial run)", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(sdkRoot, "../.."),
      encoding: "utf8",
    }).stdout.trim();
    const res = spawnSync(process.execPath, [premerge], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SHA: head,
        IC_PREMERGE_ALLOW_DIRTY: "1",
        IC_PREMERGE_STOP_AFTER: "guard:12",
        IC_PREMERGE_ALLOW_STOP_AFTER: "1",
      },
    });
    assert.equal(res.status, 92);
    assert.match(res.stderr + res.stdout, /partial run/);
  });

  it("IC_PREMERGE_SKIP_LEGS without allow flag exits non-zero", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(sdkRoot, "../.."),
      encoding: "utf8",
    }).stdout.trim();
    const res = spawnSync(process.execPath, [premerge], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SHA: head,
        IC_PREMERGE_ALLOW_DIRTY: "1",
        IC_PREMERGE_SKIP_LEGS: "1",
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /refuses IC_PREMERGE_SKIP_LEGS/);
  });
});
