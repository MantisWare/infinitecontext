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
    if (m.base_vector) payload.base_vector = m.base_vector;
  }
  /** @type {Record<string, unknown>} */
  const change = {
    op: m.op,
    context_id: m.context_id ?? null,
    client_id: m.client_id,
    payload,
    sequence: 999,
    created_at: "2099-01-01T00:00:00.000Z",
    hlc: serializeMutationHlc(item.hlcTuple),
    source_dev_h: item.devH,
    source_seq: item.seq,
    source_index: item.index,
  };
  if (m.base_vector) change.base_vector = m.base_vector;
  return change;
}

function emptyReplica() {
  return { contexts: {}, messages: {}, sync_conflicts: [] };
}

/** @param {ReturnType<typeof emptyReplica>} replica */
function conflictRowsSnapshot(replica) {
  return JSON.stringify(
    [...(replica.sync_conflicts ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  );
}

/** @param {ReturnType<typeof emptyReplica>} replica */
function fullSnapshot(replica) {
  return JSON.stringify({
    conflicts: [...(replica.sync_conflicts ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    messages: replica.messages,
  });
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

/** @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items @param {number} [trials] */
function assertConvergesAcrossRandomPulls(items, trials = 300) {
  const sorted = sortMergeableMutations(items);
  const canonical = emptyReplica();
  for (const item of sorted) {
    applySyncChangeToReplica(canonical, syncChangeFromMergeable(item), () => {});
  }
  const expected = fullSnapshot(canonical);
  const plans = randomPullBatchPlans(sorted, trials);
  /** @type {string[]} */
  const distinct = [];
  for (const batches of plans) {
    const trial = emptyReplica();
    for (const batch of batches) {
      for (const item of batch) {
        applySyncChangeToReplica(trial, syncChangeFromMergeable(item), () => {});
      }
    }
    const snap = fullSnapshot(trial);
    if (!distinct.includes(snap)) distinct.push(snap);
    assert.equal(snap, expected);
  }
  assert.equal(distinct.length, 1);
}

function msg(id, body) {
  return {
    id,
    role: "user",
    content: { body },
    metadata: { ic_client_node_id: id },
  };
}

describe("object store replica conflicts", () => {
  it("append, delete, slow update — full rows match across 300 random pull orders", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
    const ctx = "ctx_conflicts";
    const msgId = "icn_conflict_target_msg_00001";
    const createdAt = "2026-06-01T12:00:00.000Z";
    const deleteBase = { kind: "vector", v: { [devA]: 2 } };

    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [
      mergeableFromMutation(
        { client_id: "icn_create", op: "context_create", context_id: ctx, payload: { context_id: ctx, metadata: {} }, hlc: { wall_ms: 1000, counter: 0, devH: devA } },
        devA, 0, 0, "11111111-1111-4111-8111-111111111111", createdAt,
      ),
      mergeableFromMutation(
        { client_id: "icn_append", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "v1")] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
        devA, 1, 0, "11111111-1111-4111-8111-111111111111", createdAt,
      ),
      mergeableFromMutation(
        { client_id: "icn_slow", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "slow")] }, hlc: { wall_ms: 2500, counter: 0, devH: devB } },
        devB, 0, 0, "22222222-2222-4222-8222-222222222222", createdAt,
      ),
      mergeableFromMutation(
        { client_id: "icn_fast", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "fast")] }, hlc: { wall_ms: 3000, counter: 0, devH: devA } },
        devA, 2, 0, "11111111-1111-4111-8111-111111111111", createdAt,
      ),
      mergeableFromMutation(
        {
          client_id: "icn_del",
          op: "message_delete",
          context_id: ctx,
          base_vector: deleteBase,
          payload: { ids: [msgId], base_vector: deleteBase },
          hlc: { wall_ms: 4000, counter: 0, devH: devA },
        },
        devA, 3, 0, "11111111-1111-4111-8111-111111111111", createdAt,
      ),
      mergeableFromMutation(
        { client_id: "icn_after", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "after")] }, hlc: { wall_ms: 5000, counter: 0, devH: devB } },
        devB, 1, 0, "22222222-2222-4222-8222-222222222222", createdAt,
      ),
    ];
    assertConvergesAcrossRandomPulls(items);
  });

  it("concurrent updates converge across 300 random pull orders", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
    const ctx = "ctx_concurrent";
    const msgId = "icn_concurrent_msg";
    const t = "2026-06-02T12:00:00.000Z";
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [
      mergeableFromMutation(
        { client_id: "c1", op: "context_create", context_id: ctx, payload: { context_id: ctx, metadata: {} }, hlc: { wall_ms: 1000, counter: 0, devH: devA } },
        devA, 0, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "c2", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "base")] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
        devA, 1, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "c3", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "from-a")] }, hlc: { wall_ms: 3000, counter: 0, devH: devA } },
        devA, 2, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "c4", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "from-b")] }, hlc: { wall_ms: 3000, counter: 1, devH: devB } },
        devB, 0, 0, "22222222-2222-4222-8222-222222222222", t,
      ),
    ];
    assertConvergesAcrossRandomPulls(items);
  });

  it("three updates converge across 300 random pull orders", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_three";
    const msgId = "icn_three_msg";
    const t = "2026-06-03T12:00:00.000Z";
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [
      mergeableFromMutation(
        { client_id: "t0", op: "context_create", context_id: ctx, payload: { context_id: ctx, metadata: {} }, hlc: { wall_ms: 1000, counter: 0, devH: devA } },
        devA, 0, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "t1", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "u1")] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
        devA, 1, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "t2", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "u2")] }, hlc: { wall_ms: 3000, counter: 0, devH: devA } },
        devA, 2, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "t3", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "u3")] }, hlc: { wall_ms: 4000, counter: 0, devH: devA } },
        devA, 3, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
    ];
    assertConvergesAcrossRandomPulls(items);
  });

  it("two updates plus delete converge across 300 random pull orders", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_two_del";
    const msgId = "icn_two_del_msg";
    const t = "2026-06-04T12:00:00.000Z";
    const deleteBase = { kind: "vector", v: { [devA]: 1 } };
    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [
      mergeableFromMutation(
        { client_id: "d0", op: "context_create", context_id: ctx, payload: { context_id: ctx, metadata: {} }, hlc: { wall_ms: 1000, counter: 0, devH: devA } },
        devA, 0, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "d1", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "u1")] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
        devA, 1, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        { client_id: "d2", op: "message_update", context_id: ctx, payload: { messages: [msg(msgId, "u2")] }, hlc: { wall_ms: 3000, counter: 0, devH: devA } },
        devA, 2, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
      mergeableFromMutation(
        {
          client_id: "d3",
          op: "message_delete",
          context_id: ctx,
          base_vector: deleteBase,
          payload: { ids: [msgId], base_vector: deleteBase },
          hlc: { wall_ms: 4000, counter: 0, devH: devA },
        },
        devA, 3, 0, "11111111-1111-4111-8111-111111111111", t,
      ),
    ];
    assertConvergesAcrossRandomPulls(items);
  });

  it("covered delete does not add a tombstone conflict for a seen value", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_cov";
    const msgId = "icn_cov";
    const deleteBase = { kind: "vector", v: { [devA]: 2 } };
    const replica = emptyReplica();
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          { client_id: "x0", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "win")] }, hlc: { wall_ms: 3000, counter: 0, devH: devA } },
          devA, 2, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
        ),
      ),
      () => {},
    );
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          {
            client_id: "x1",
            op: "message_delete",
            context_id: ctx,
            base_vector: deleteBase,
            payload: { ids: [msgId], base_vector: deleteBase },
            hlc: { wall_ms: 4000, counter: 0, devH: devA },
          },
          devA, 3, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
        ),
      ),
      () => {},
    );
    assert.equal(replica.sync_conflicts.length, 0);
  });

  it("does not record a conflict for delete with no prior message payload", () => {
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const replica = emptyReplica();
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          {
            client_id: "icn_del_only",
            op: "message_delete",
            context_id: "ctx_x",
            base_vector: { kind: "vector", v: {} },
            payload: { ids: ["icn_missing_msg"], base_vector: { kind: "vector", v: {} } },
            hlc: { wall_ms: 4000, counter: 0, devH: devA },
          },
          devA, 0, 0, "11111111-1111-4111-8111-111111111111", new Date().toISOString(),
        ),
      ),
      () => {},
    );
    assert.equal(replica.sync_conflicts.length, 0);
  });
});
