import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeMutationHlc } from "../../lib/object-store-hlc.mjs";
import {
  mergeableFromMutation,
  permuteMutationBatches,
  sortMergeableMutations,
} from "../../lib/object-store-merge.mjs";
import { applySyncChangeToReplica } from "../../lib/sync-engine.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

const TEST_DEK = new Uint8Array(32).fill(9);

/** @param {import('../../lib/object-store-merge.mjs').MergeableMutation} item */
function syncChangeFromMergeable(item) {
  const m = item.mutation;
  const payload =
    m.payload && typeof m.payload === "object" ? { ...m.payload } : {};
  if (m.op === "message_append" || m.op === "message_update") {
    const rows = Array.isArray(payload.messages) ? payload.messages : [];
    payload.data = rows;
  }
  if (m.op === "message_delete") {
    payload.deleted_client_ids = Array.isArray(payload.ids)
      ? payload.ids.map(String)
      : payload.ids !== undefined
        ? [String(payload.ids)]
        : [];
  }
  return {
    op: m.op,
    context_id: m.context_id ?? null,
    client_id: m.client_id,
    payload,
    sequence: 1,
    created_at: item.segmentCreatedAt,
    hlc: serializeMutationHlc(item.hlcTuple),
    source_dev_h: item.devH,
    source_seq: item.seq,
    source_index: item.index,
  };
}

function emptyReplica() {
  return { contexts: {}, messages: {}, sync_conflicts: [] };
}

/** @param {ReturnType<typeof emptyReplica>} replica */
function snapshotReplica(replica) {
  const conflicts = [...(replica.sync_conflicts ?? [])].map((c) => c.id).sort();
  const messages = JSON.stringify(replica.messages);
  return { conflicts, messages };
}

/** @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items */
function applyAllChanges(replica, items) {
  for (const item of sortMergeableMutations(items)) {
    applySyncChangeToReplica(replica, syncChangeFromMergeable(item), () => {});
  }
}

/** @param {unknown[][]} batches */
function permuteBatchOrders(batches) {
  if (batches.length <= 1) return [batches];
  /** @param {number[]} idx @param {number} n @param {number[][]} out */
  function permute(idx, n, out) {
    if (n === 1) {
      out.push(idx.map((i) => batches[i]));
      return;
    }
    for (let i = 0; i < n; i += 1) {
      permute(idx, n - 1, out);
      const j = n % 2 === 0 ? i : 0;
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
  }
  /** @type {unknown[][][]} */
  const out = [];
  permute(batches.map((_, i) => i), batches.length, out);
  return out;
}

describe("object store replica conflicts", () => {
  it("records identical conflict sets for append, delete, slow-clock, and concurrent updates", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
    const ctx = "ctx_conflicts";
    const msgId = "icn_conflict_target_msg_00001";
    const createdAt = "2026-06-01T12:00:00.000Z";

    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [
      mergeableFromMutation(
        {
          client_id: "icn_create_ctx",
          op: "context_create",
          context_id: ctx,
          payload: { context_id: ctx, metadata: {} },
          hlc: { wall_ms: 1000, counter: 0, devH: devA },
        },
        devA,
        0,
        0,
        "11111111-1111-4111-8111-111111111111",
        createdAt,
      ),
      mergeableFromMutation(
        {
          client_id: "icn_append",
          op: "message_append",
          context_id: ctx,
          payload: {
            messages: [
              {
                id: msgId,
                role: "user",
                content: { body: "v1" },
                metadata: { ic_client_node_id: msgId },
              },
            ],
          },
          hlc: { wall_ms: 2000, counter: 0, devH: devA },
        },
        devA,
        1,
        0,
        "11111111-1111-4111-8111-111111111111",
        createdAt,
      ),
      mergeableFromMutation(
        {
          client_id: "icn_slow",
          op: "message_update",
          context_id: ctx,
          payload: {
            messages: [
              {
                id: msgId,
                role: "user",
                content: { body: "slow" },
                metadata: { ic_client_node_id: msgId },
              },
            ],
          },
          hlc: { wall_ms: 2500, counter: 0, devH: devB },
        },
        devB,
        0,
        0,
        "22222222-2222-4222-8222-222222222222",
        createdAt,
      ),
      mergeableFromMutation(
        {
          client_id: "icn_fast",
          op: "message_update",
          context_id: ctx,
          payload: {
            messages: [
              {
                id: msgId,
                role: "user",
                content: { body: "fast" },
                metadata: { ic_client_node_id: msgId },
              },
            ],
          },
          hlc: { wall_ms: 3000, counter: 0, devH: devA },
        },
        devA,
        2,
        0,
        "11111111-1111-4111-8111-111111111111",
        createdAt,
      ),
      mergeableFromMutation(
        {
          client_id: "icn_del",
          op: "message_delete",
          context_id: ctx,
          payload: { ids: [msgId] },
          hlc: { wall_ms: 4000, counter: 0, devH: devA },
        },
        devA,
        3,
        0,
        "11111111-1111-4111-8111-111111111111",
        createdAt,
      ),
      mergeableFromMutation(
        {
          client_id: "icn_after_del",
          op: "message_update",
          context_id: ctx,
          payload: {
            messages: [
              {
                id: msgId,
                role: "user",
                content: { body: "after tombstone" },
                metadata: { ic_client_node_id: msgId },
              },
            ],
          },
          hlc: { wall_ms: 5000, counter: 0, devH: devB },
        },
        devB,
        1,
        0,
        "22222222-2222-4222-8222-222222222222",
        createdAt,
      ),
    ];

    const canonical = emptyReplica();
    applyAllChanges(canonical, items);
    const expected = snapshotReplica(canonical);
    assert.ok(expected.conflicts.length >= 3);

    for (const batchPlan of [1, 3]) {
      const batches = permuteMutationBatches(items, batchPlan);
      for (const order of permuteBatchOrders(batches)) {
        const batched = emptyReplica();
        for (const part of order) {
          for (const item of part) {
            applySyncChangeToReplica(batched, syncChangeFromMergeable(item), () => {});
          }
        }
        assert.deepEqual(snapshotReplica(batched), expected);
      }
    }
  });
});
