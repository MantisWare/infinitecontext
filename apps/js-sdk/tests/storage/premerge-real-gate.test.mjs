import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const repoRoot = path.resolve(sdkRoot, "../..");
const premerge = path.join(sdkRoot, "scripts/premerge.mjs");

/**
 * @param {Record<string, string>} extraEnv
 */
function runPremergeProbe(extraEnv) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  return spawnSync(process.execPath, [premerge], {
    cwd: sdkRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SHA: head,
      IC_PREMERGE_SKIP_LEGS: "1",
      IC_PREMERGE_ALLOW_SKIP_LEGS: "1",
      IC_PREMERGE_ALLOW_DIRTY: "1",
      ...extraEnv,
    },
  });
}

describe("real premerge gate failures", () => {
  it("floor violation exits non-zero without premerge summary success path", () => {
    const res = runPremergeProbe({ IC_PREMERGE_PROBE: "floor-violation" });
    assert.notEqual(res.status, 0);
    assert.match(
      res.stderr + res.stdout,
      /premerge package test coverage failed|exact count required|pass \d+ [<>] floor/,
    );
    assert.doesNotMatch(res.stdout, /starting storage emulator/);
  });

  it("missing package exits non-zero", () => {
    const res = runPremergeProbe({ IC_PREMERGE_PROBE: "missing-package" });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /missing from pnpm test output/);
  });

  it("zero tests exits non-zero", () => {
    const res = runPremergeProbe({ IC_PREMERGE_PROBE: "zero-tests" });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /false-green|missing test summary|pass \d+ < floor/);
  });

  it("EXPECTED_SHA mismatch at final gate exits non-zero", () => {
    const res = runPremergeProbe({ IC_PREMERGE_PROBE: "expected-sha-mismatch" });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /EXPECTED_SHA mismatch/);
    assert.doesNotMatch(res.stdout, /premerge summary:/);
  });
});
