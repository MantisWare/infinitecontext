import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeVectorSyncCursor } from "../src/index.mjs";

describe("@infinitecontext/sync-cursor smoke", () => {
  it("normalizeVectorSyncCursor accepts empty input", () => {
    assert.deepEqual(normalizeVectorSyncCursor(null), { kind: "vector", v: {} });
  });
});
