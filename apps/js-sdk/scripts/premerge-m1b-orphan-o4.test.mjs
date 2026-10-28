import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(sdkRoot, "scripts/premerge-m1b-orphan-o4-probe.mjs");

describe("M1b orphan defense (O4)", () => {
  it("orphan pid file lives outside private TMPDIR and orphan is reaped on SIGINT", () => {
    const run = spawnSync(process.execPath, [probe], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(
      run.status,
      0,
      `O4 probe failed: stdout=${run.stdout}\nstderr=${run.stderr}`,
    );
  });
});
