import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(sdkRoot, "scripts/premerge-committed-mutant-runner.mjs");

describe("committed source mutants (clean tree)", () => {
  it("regression tests fail on committed mutant branches", () => {
    const run = spawnSync(process.execPath, [runner], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: { ...process.env },
      execArgv: [],
    });
    assert.equal(
      run.status,
      0,
      `runner failed: stdout=${run.stdout}\nstderr=${run.stderr}`,
    );
    assert.match(run.stdout + run.stderr, /committed-mutant-runner: all regressions failed/);
  });
});
