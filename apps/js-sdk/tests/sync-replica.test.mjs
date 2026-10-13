import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySyncChangeToReplica } from "../lib/sync-engine.mjs";

describe("sync replica apply", () => {
  it("contexts_delete_many marks only rows with deleted: true", () => {
    const replica = { contexts: { ctx_a: { deleted: false }, ctx_missing: { deleted: false } }, messages: {} };
    applySyncChangeToReplica(
      replica,
      {
        op: "contexts_delete_many",
        sequence: 1,
        payload: {
          results: [
            { id: "ctx_a", deleted: true },
            { id: "ctx_missing", deleted: false, error: "Not found" },
          ],
        },
      },
      () => {},
    );
    assert.equal(replica.contexts.ctx_a.deleted, true);
    assert.equal(replica.contexts.ctx_missing.deleted, false);
  });

  it("message_delete removes only deleted_client_ids", () => {
    const replica = {
      contexts: {},
      messages: {
        icn_a: { context_id: "ctx_1", payload: {} },
        icn_b: { context_id: "ctx_1", payload: {} },
      },
    };
    applySyncChangeToReplica(
      replica,
      {
        op: "message_delete",
        context_id: "ctx_1",
        sequence: 2,
        payload: { deleted_client_ids: ["icn_a"], version: 1 },
      },
      () => {},
    );
    assert.equal(replica.messages.icn_a, undefined);
    assert.ok(replica.messages.icn_b);
  });
});
