import assert from "node:assert/strict";

import { serializeMutationHlc } from "../../lib/object-store-hlc.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";

/** @param {import('../../lib/object-store-merge.mjs').MergeableMutation} item */
export function syncChangeFromMergeable(item) {
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

/** @param {ReturnType<typeof createEmptySyncReplica>} replica */
export function fullSnapshot(replica) {
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

/**
 * @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items
 * @param {(replica: ReturnType<typeof createEmptySyncReplica>, change: Record<string, unknown>) => void} applyChange
 * @param {number} [trials]
 */
export function assertConvergesAcrossRandomPulls(items, applyChange, trials = 300) {
  const sorted = sortMergeableMutations(items);
  const canonical = createEmptySyncReplica();
  for (const item of sorted) {
    applyChange(canonical, syncChangeFromMergeable(item));
  }
  const expected = fullSnapshot(canonical);
  const plans = randomPullBatchPlans(sorted, trials);
  for (const batches of plans) {
    const trial = createEmptySyncReplica();
    for (const batch of batches) {
      for (const item of batch) {
        applyChange(trial, syncChangeFromMergeable(item));
      }
    }
    assert.equal(fullSnapshot(trial), expected);
  }
}

/**
 * Daemon replica: apply into store.loadSyncReplica(), flush once per trial, compare loaded snapshot.
 * @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items
 * @param {{ load: () => ReturnType<typeof createEmptySyncReplica>, flush: () => void }} store
 * @param {number} [trials]
 */
export function assertDaemonStoreConvergesAcrossRandomPulls(items, store, trials = 300) {
  const sorted = sortMergeableMutations(items);
  const applyToStore = (change) => {
    applySyncChangeToReplica(store.load(), change, () => {});
  };
  for (const item of sorted) {
    applyToStore(syncChangeFromMergeable(item));
  }
  store.flush();
  const expected = fullSnapshot(store.load());
  const plans = randomPullBatchPlans(sorted, trials);
  for (const batches of plans) {
    store.reset();
    for (const batch of batches) {
      for (const item of batch) {
        applyToStore(syncChangeFromMergeable(item));
      }
    }
    store.flush();
    assert.equal(fullSnapshot(store.load()), expected);
  }
}
