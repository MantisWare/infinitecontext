import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import {
  getRecomputePerfCounterForTests,
  getRecomputePerfEntryScanStatsForTests,
  resetRecomputePerfCounterForTests,
} from "../../lib/object-store-replica-conflicts.mjs";
import { serializeMutationHlc } from "../../lib/object-store-hlc.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { msg, TEST_DEK } from "./object-store-replica-scenarios.mjs";

describe("object store replica recompute performance", () => {
  it("recomputes 2400 sequential edits to one message with bounded recompute work", () => {
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

    resetRecomputePerfCounterForTests();
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
    assert.equal(getRecomputePerfCounterForTests(), 2400);
    const scanStats = getRecomputePerfEntryScanStatsForTests();
    assert.ok(
      scanStats.maxEntries <= 2401,
      `recompute scanned too many log entries per call (${scanStats.maxEntries})`,
    );
    assert.ok(
      scanStats.totalScans <= 2400 * 2402,
      `total recompute entry scans regressed (${scanStats.totalScans})`,
    );
    assert.equal(replica.sync_conflicts.length, 0);
    assert.equal(replica.messages[msgId].payload.content.body, "u2400");
  });

  it("recomputes 2400 concurrent edits to one message (2400 conflict rows)", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
    const ctx = "ctx_perf_concurrent";
    const msgId = "icn_perf_concurrent";
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

    resetRecomputePerfCounterForTests();
    let appliedUpdates = 0;
    for (let i = 1; i <= 2400; i += 1) {
      const devH = i % 2 === 0 ? devB : devA;
      applySyncChangeToReplica(
        replica,
        {
          op: "message_update",
          context_id: ctx,
          sequence: i + 1,
          hlc: serializeMutationHlc({ wall_ms: 1000 + i, counter: i % 7, devH }),
          source_dev_h: devH,
          source_seq: Math.floor(i / 2),
          source_index: i % 2,
          payload: { context_id: ctx, data: [msg(msgId, `u${i}`)] },
        },
        () => {},
      );
      appliedUpdates += 1;
    }
    assert.equal(appliedUpdates, 2400);
    assert.equal(getRecomputePerfCounterForTests(), 2400);
    assert.equal(replica.sync_conflicts.length, 2400);
  });
});
