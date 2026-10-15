import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { serializeMutationHlc } from "../../lib/object-store-hlc.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { msg, TEST_DEK } from "./object-store-replica-scenarios.mjs";

describe("object store replica recompute performance", () => {
  it("recomputes 2400 sequential edits to one message in under 2s", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_perf";
    const msgId = "icn_perf_msg";
    const replica = createEmptySyncReplica();
    applySyncChangeToReplica(
      replica,
      {
        op: "message_append",
        context_id: ctx,
        sequence: 1,
        hlc: serializeMutationHlc({ wall_ms: 1000, counter: 0, devH: devA }),
        source_dev_h: devA,
        source_seq: 0,
        source_index: 0,
        payload: { context_id: ctx, data: [msg(msgId, "u0")] },
      },
      () => {},
    );

    const start = performance.now();
    for (let i = 1; i <= 2400; i += 1) {
      applySyncChangeToReplica(
        replica,
        {
          op: "message_update",
          context_id: ctx,
          sequence: i + 1,
          hlc: serializeMutationHlc({ wall_ms: 1000 + i, counter: 0, devH: devA }),
          source_dev_h: devA,
          source_seq: i,
          source_index: 0,
          base_vector: { kind: "vector", v: { [devA]: i - 1 } },
          payload: { context_id: ctx, data: [msg(msgId, `u${i}`)] },
        },
        () => {},
      );
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2000, `expected < 2000ms, got ${elapsed.toFixed(1)}ms`);
    assert.equal(replica.sync_conflicts.length, 0);
    assert.equal(replica.messages[msgId].payload.content.body, "u2400");
  });
});
