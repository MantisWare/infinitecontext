import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInjectedTestHookActive, readTestHook } from "../../lib/storage/test-hooks.mjs";

describe("test hook production gating", () => {
  it("ignores env hooks outside NODE_ENV=test", () => {
    const env = { NODE_ENV: "production", INFINITECONTEXT_KEYRING_PROBE_FORCE: "fail" };
    assert.equal(readTestHook("keyringProbeForce", env), undefined);
  });

  it("ignores injected compaction/sync hooks outside NODE_ENV=test", () => {
    const env = { NODE_ENV: "production" };
    assert.equal(
      isInjectedTestHookActive({ testHookAfterSnapshotWrite: async () => {} }, "testHookAfterSnapshotWrite", env),
      false,
    );
    assert.equal(
      isInjectedTestHookActive({ testHookAfterSegmentWrite: async () => {} }, "testHookAfterSegmentWrite", env),
      false,
    );
  });
});
