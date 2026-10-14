import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeMutationHlc } from "../../lib/object-store-hlc.mjs";
import { mergeableFromMutation, sortMergeableMutations } from "../../lib/object-store-merge.mjs";
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
  const conflicts = [...(replica.sync_conflicts ?? [])]
    .map((c) => ({ id: c.id, kind: c.kind }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { conflicts, messages: JSON.stringify(replica.messages) };
}

/** @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} sorted */
function randomPullBatchPlans(sorted, trials) {
  /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[][][]} */
  const plans = [];
  for (let t = 0; t < trials; t += 1) {
    const batchCount = 1 + Math.floor(Math.random() * 4);
    /** @type {number[]} */
    const cuts = [0, sorted.length];
    while (cuts.length <= batchCount) {
      const at = 1 + Math.floor(Math.random() * Math.max(1, sorted.length - 1));
      if (!cuts.includes(at)) cuts.push(at);
    }
    cuts.sort((a, b) => a - b);
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[][]} */
    const batches = [];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const slice = sorted.slice(cuts[i], cuts[i + 1]);
      if (slice.length) batches.push(slice);
    }
    for (let i = batches.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [batches[i], batches[j]] = [batches[j], batches[i]];
    }
    plans.push(batches.length ? batches : [sorted]);
  }
  return plans;
}

/** @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items */
function buildConflictScenarioItems(items) {
  const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
  const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
  const ctx = "ctx_conflicts";
  const msgId = "icn_conflict_target_msg_00001";
  const createdAt = "2026-06-01T12:00:00.000Z";

  items.push(
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
  );
}

describe("object store replica conflicts", () => {
  it("append, delete, slow-clock update converge across 300 random pull orders", () => {
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [];
    buildConflictScenarioItems(items);
    const sorted = sortMergeableMutations(items);

    const canonical = emptyReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(canonical, syncChangeFromMergeable(item), () => {});
    }
    const expected = snapshotReplica(canonical);
    assert.ok(expected.conflicts.length >= 2);
    for (const row of expected.conflicts) {
      assert.match(row.id, /^[^:]+:[0-9A-HJKMNP-TV-Z]{26}:\d+:\d+$/);
      assert.ok(row.kind === "tombstone_blocked_update" || row.kind === "lww_superseded");
    }

    const plans = randomPullBatchPlans(sorted, 300);
    /** @type {string[]} */
    const seen = [];
    for (const batches of plans) {
      const trial = emptyReplica();
      for (const batch of batches) {
        for (const item of batch) {
          applySyncChangeToReplica(trial, syncChangeFromMergeable(item), () => {});
        }
      }
      const snap = JSON.stringify(snapshotReplica(trial));
      if (!seen.includes(snap)) seen.push(snap);
      assert.deepEqual(snapshotReplica(trial), expected);
    }
    assert.equal(seen.length, 1);
  });

  it("does not record a conflict for delete with no prior message payload", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const replica = emptyReplica();
    const del = mergeableFromMutation(
      {
        client_id: "icn_del_only",
        op: "message_delete",
        context_id: "ctx_x",
        payload: { ids: ["icn_missing_msg"] },
        hlc: { wall_ms: 4000, counter: 0, devH: devA },
      },
      devA,
      0,
      0,
      "11111111-1111-4111-8111-111111111111",
      new Date().toISOString(),
    );
    applySyncChangeToReplica(replica, syncChangeFromMergeable(del), () => {});
    assert.equal(replica.sync_conflicts.length, 0);
  });
});
