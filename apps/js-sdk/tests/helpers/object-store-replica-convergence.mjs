import assert from "node:assert/strict";

import { serializeMutationHlc } from "../../lib/object-store-hlc.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { hydrateSyncReplica, sanitizeSyncReplicaForPersist } from "../../lib/sync-replica-state.mjs";

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
export function randomPullBatchPlans(sorted, trials) {
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
 * CLI replica: apply, persist, reload from disk after every change (restart simulation).
 * @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items
 * @param {number} [trials]
 */
export function assertCliPersistedConvergesAcrossRandomPulls(items, trials = 300) {
  assertConvergesAcrossRandomPulls(items, (replica, change) => {
    applySyncChangeToReplica(replica, change, () => {});
    const reloaded = hydrateSyncReplica(sanitizeSyncReplicaForPersist(replica));
    replica.contexts = reloaded.contexts;
    replica.messages = reloaded.messages;
    replica.sync_conflicts = reloaded.sync_conflicts;
    replica._message_mutations = reloaded._message_mutations;
    rebuildIndexFromReplica(replica);
  }, trials);
}

/** @param {ReturnType<typeof createEmptySyncReplica>} replica */
function rebuildIndexFromReplica(replica) {
  /** @type {Record<string, Set<string>>} */
  const index = {};
  const log = replica._message_mutations;
  if (log && typeof log === "object") {
    for (const [messageId, entries] of Object.entries(log)) {
      if (!Array.isArray(entries)) continue;
      const set = new Set();
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const row = /** @type {Record<string, unknown>} */ (entry);
        set.add(`${messageId}:${row.devH}:${row.seq}:${row.index ?? 0}`);
      }
      index[messageId] = set;
    }
  }
  replica._mutation_log_ids = index;
}

/**
 * Daemon replica: applySyncChange per change, clear in-memory cache after each (reload from db).
 * @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items
 * @param {{
 *   applySyncChange: (change: Record<string, unknown>) => void,
 *   load: () => ReturnType<typeof createEmptySyncReplica>,
 *   clearReplicaCache: () => void,
 *   reset: () => void,
 * }} store
 * @param {number} [trials]
 */
export function assertDaemonStoreConvergesAcrossRandomPulls(items, store, trials = 300) {
  const sorted = sortMergeableMutations(items);
  for (const item of sorted) {
    store.applySyncChange(syncChangeFromMergeable(item));
    store.clearReplicaCache();
  }
  store.clearReplicaCache();
  const expected = fullSnapshot(store.load());
  const plans = randomPullBatchPlans(sorted, trials);
  for (const batches of plans) {
    store.reset();
    for (const batch of batches) {
      for (const item of batch) {
        store.applySyncChange(syncChangeFromMergeable(item));
        store.clearReplicaCache();
      }
    }
    assert.equal(fullSnapshot(store.load()), expected);
  }
}
