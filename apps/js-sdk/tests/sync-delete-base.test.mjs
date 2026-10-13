import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mutationForMessageDelete, resolveDeleteBaseSequence } from "../lib/sync-engine.mjs";

describe("message_delete base_sequence", () => {
  it("resolveDeleteBaseSequence never returns server head fallback", () => {
    assert.equal(resolveDeleteBaseSequence({ explicitBaseSequence: 12 }), 12);
    assert.equal(resolveDeleteBaseSequence({}), null);
  });

  it("mutationForMessageDelete throws without a known base", () => {
    assert.throws(
      () => mutationForMessageDelete("ctx_test", ["icn_" + "a".repeat(24)]),
      /base_sequence is required/,
    );
  });

  it("mutationForMessageDelete accepts explicit base_sequence", () => {
    const mutation = mutationForMessageDelete("ctx_test", [0], { base_sequence: 7 });
    assert.equal(mutation.base_sequence, 7);
    assert.equal(mutation.op, "message_delete");
  });
});
