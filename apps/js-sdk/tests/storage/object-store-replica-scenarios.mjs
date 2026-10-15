import { mergeableFromMutation } from "../../lib/object-store-merge.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

export const TEST_DEK = new Uint8Array(32).fill(9);

export function msg(id, body) {
  return {
    id,
    role: "user",
    content: { body },
    metadata: { ic_client_node_id: id },
  };
}

/** @returns {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
export function scenarioAppendDeleteSlowUpdate() {
  const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
  const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
  const ctx = "ctx_conflicts";
  const msgId = "icn_conflict_target_msg_00001";
  const createdAt = "2026-06-01T12:00:00.000Z";
  const deleteBase = { kind: "vector", v: { [devA]: 2 } };
  return [
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
}

/** @returns {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
export function scenarioConcurrentUpdates() {
  const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
  const devB = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
  const ctx = "ctx_concurrent";
  const msgId = "icn_concurrent_msg";
  const t = "2026-06-02T12:00:00.000Z";
  return [
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
}

/** @returns {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
export function scenarioThreeUpdates() {
  const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
  const ctx = "ctx_three";
  const msgId = "icn_three_msg";
  const t = "2026-06-03T12:00:00.000Z";
  return [
    mergeableFromMutation(
      { client_id: "t0", op: "context_create", context_id: ctx, payload: { context_id: ctx, metadata: {} }, hlc: { wall_ms: 1000, counter: 0, devH: devA } },
      devA, 0, 0, "11111111-1111-4111-8111-111111111111", t,
    ),
    mergeableFromMutation(
      { client_id: "t1", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, "u1")] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
      devA, 1, 0, "11111111-1111-4111-8111-111111111111", t,
    ),
    mergeableFromMutation(
      {
        client_id: "t2",
        op: "message_update",
        context_id: ctx,
        base_vector: { kind: "vector", v: { [devA]: 1 } },
        payload: { messages: [msg(msgId, "u2")], base_vector: { kind: "vector", v: { [devA]: 1 } } },
        hlc: { wall_ms: 3000, counter: 0, devH: devA },
      },
      devA, 2, 0, "11111111-1111-4111-8111-111111111111", t,
    ),
    mergeableFromMutation(
      {
        client_id: "t3",
        op: "message_update",
        context_id: ctx,
        base_vector: { kind: "vector", v: { [devA]: 2 } },
        payload: { messages: [msg(msgId, "u3")], base_vector: { kind: "vector", v: { [devA]: 2 } } },
        hlc: { wall_ms: 4000, counter: 0, devH: devA },
      },
      devA, 3, 0, "11111111-1111-4111-8111-111111111111", t,
    ),
  ];
}

/** @returns {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
export function scenarioTwoUpdatesPlusDelete() {
  const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
  const ctx = "ctx_two_del";
  const msgId = "icn_two_del_msg";
  const t = "2026-06-04T12:00:00.000Z";
  const deleteBase = { kind: "vector", v: { [devA]: 1 } };
  return [
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
}

export const ALL_CONVERGENCE_SCENARIOS = [
  ["append, delete, slow update", scenarioAppendDeleteSlowUpdate],
  ["concurrent updates", scenarioConcurrentUpdates],
  ["three updates", scenarioThreeUpdates],
  ["two updates plus delete", scenarioTwoUpdatesPlusDelete],
];
