import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";

describe("client icn ids (96-bit random)", () => {
  it("uses 12 random bytes (96 bits) — collisions negligible at scale", () => {
    const ids = new Set();
    const trials = 50_000;
    for (let i = 0; i < trials; i += 1) {
      const id = generateClientNodeId();
      assert.match(id, /^icn_[0-9a-f]{24}$/);
      ids.add(id);
    }
    assert.equal(ids.size, trials);
  });
});
