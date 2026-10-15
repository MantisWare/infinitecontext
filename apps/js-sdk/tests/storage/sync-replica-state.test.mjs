import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ObjectStoreSyncStateError } from "../../lib/object-store-state-errors.mjs";
import { hydrateSyncReplica } from "../../lib/sync-replica-state.mjs";

describe("sync replica state validation", () => {
  it("throws ObjectStoreSyncStateError for corrupt mutation log", () => {
    assert.throws(
      () =>
        hydrateSyncReplica({
          contexts: {},
          messages: {},
          sync_conflicts: [],
          _message_mutations: { icn_x: "not-an-array" },
        }),
      (err) => err instanceof ObjectStoreSyncStateError && err.code === "corrupt_state",
    );
  });
});
