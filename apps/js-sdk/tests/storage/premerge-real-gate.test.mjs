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
      IC_PREMERGE_FORCE_NO_PTY: "",
      ...extraEnv,
    },
  });
}

describe("real premerge gate failures", () => {
  for (const probe of ["floor-violation", "missing-package", "zero-tests", "expected-sha-mismatch", "green"]) {
    it(`SKIP_LEGS probe ${probe} exits 92 SYNTHETIC (never green summary)`, () => {
      const res = runPremergeProbe({ IC_PREMERGE_PROBE: probe });
      assert.equal(res.status, 92);
      assert.match(res.stderr + res.stdout, /SYNTHETIC/);
      assert.doesNotMatch(res.stdout, /premerge summary:[\s\S]*pass: \d+/);
      assert.doesNotMatch(res.stdout, /starting storage emulator/);
    });
  }

  it("unknown SKIP_LEGS probe exits non-zero without green summary", () => {
    const res = runPremergeProbe({ IC_PREMERGE_PROBE: "not-a-real-probe" });
    assert.notEqual(res.status, 0);
    assert.notEqual(res.status, 92);
    assert.match(res.stderr + res.stdout, /unknown IC_PREMERGE_PROBE/);
    assert.doesNotMatch(res.stdout, /premerge summary:/);
  });
});
