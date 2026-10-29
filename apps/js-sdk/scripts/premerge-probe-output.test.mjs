import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { premergeProbeTestOutput } from "./premerge-probe-output.mjs";

describe("premergeProbeTestOutput", () => {
  it("refuses unknown probe values", () => {
    for (const probe of ["x", "garbage", "not-a-probe"]) {
      assert.throws(() => premergeProbeTestOutput(probe), /unknown IC_PREMERGE_PROBE/);
    }
    assert.throws(() => premergeProbeTestOutput(""), /unknown IC_PREMERGE_PROBE/);
  });

  it("accepts known probes", () => {
    for (const probe of ["ok", "green", "floor-violation"]) {
      assert.match(premergeProbeTestOutput(probe), /> infinitecontext@/);
    }
    assert.match(premergeProbeTestOutput("missing-package"), /> @infinitecontext\/auth@/);
    assert.match(premergeProbeTestOutput("zero-tests"), /> infinitecontext@/);
  });
});
