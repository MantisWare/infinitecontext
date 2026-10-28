import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  COMMITTED_MUTANT_CASES,
  runInCommittedMutantWorktree,
} from "./premerge-committed-mutant-runner.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
const patchDir = path.join(sdkRoot, "tests/fixtures/committed-mutants");

describe("committed source mutants (clean tree)", () => {
  for (const c of COMMITTED_MUTANT_CASES) {
    it(`${c.id}: patch applies on HEAD and regression test fails on mutant branch`, () => {
      const patchPath = path.join(patchDir, c.patch);
      const check = spawnSync("git", ["apply", "--check", patchPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.equal(
        check.status,
        0,
        `${c.id}: patch must apply on clean HEAD: ${check.stderr || check.stdout}`,
      );

      const res = runInCommittedMutantWorktree(c.patch, c.testRel, c.filter);
      assert.notEqual(
        res.status,
        0,
        `${c.id}: expected targeted test failure on mutant branch; stdout=${res.stdout}\nstderr=${res.stderr}`,
      );
    });
  }

  it("runner completes all committed mutant cases", () => {
    const runner = path.join(sdkRoot, "scripts/premerge-committed-mutant-runner.mjs");
    /** @type {Record<string, string | undefined>} */
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("NODE_TEST")) {
        delete childEnv[key];
      }
    }
    const run = spawnSync(process.execPath, [runner], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: childEnv,
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
