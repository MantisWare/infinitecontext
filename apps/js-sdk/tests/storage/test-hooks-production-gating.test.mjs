import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInjectedTestHookActive } from "../../lib/storage/test-hooks.mjs";

describe("test hook production gating", () => {
  it("ignores injected compaction hooks outside NODE_ENV=test", () => {
    const env = { NODE_ENV: "production" };
    assert.equal(
      isInjectedTestHookActive({ testHookAfterSnapshotWrite: async () => {} }, "testHookAfterSnapshotWrite", env),
      false,
    );
  });
});
