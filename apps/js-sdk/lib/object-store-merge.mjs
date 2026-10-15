import { compareHlc, normalizeMutationHlc } from "./object-store-hlc.mjs";

/**
 * @typedef {import('./object-store-hlc.mjs').HlcTuple} HlcTuple
 * @typedef {Object} MergeableMutation
 * @property {HlcTuple} hlcTuple
 * @property {string} devH canonical uppercase
 * @property {number} seq
 * @property {number} index index within segment mutations array
 * @property {object} mutation
 * @property {string} deviceUuid
 * @property {string} segmentCreatedAt
 */

/**
 * @param {MergeableMutation} a
 * @param {MergeableMutation} b
 */
export function compareMergeableMutations(a, b) {
  const h = compareHlc(a.hlcTuple, b.hlcTuple);
  if (h !== 0) return h;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.index !== b.index) return a.index - b.index;
  return a.devH.localeCompare(b.devH);
}

/**
 * @param {object} mutation
 * @param {string} devH
 * @param {number} index
 * @param {string} segmentCreatedAt
 * @returns {MergeableMutation}
 */
export function mergeableFromMutation(mutation, devH, seq, index, deviceUuid, segmentCreatedAt) {
  const hlcTuple = normalizeMutationHlc(mutation.hlc, devH, index);
  return {
    hlcTuple,
    devH,
    seq,
    index,
    mutation,
    deviceUuid,
    segmentCreatedAt,
  };
}

/**
 * @param {MergeableMutation[]} items
 */
export function sortMergeableMutations(items) {
  return [...items].sort(compareMergeableMutations);
}

/**
 * @param {Map<string, unknown>} replica
 * @param {MergeableMutation} item
 */
export function applyMergeableMutationToReplica(replica, item) {
  const m = item.mutation;
  if (!m || typeof m !== "object") return;
  const op = String(m.op ?? "");
  const contextId = m.context_id ? String(m.context_id) : "";
  const hlcTuple = item.hlcTuple;

  /** @param {string} entityKey @param {unknown} value */
  const setIfNewer = (entityKey, value) => {
    const existing = replica.get(entityKey);
    if (existing && typeof existing === "object" && existing !== null && "_hlc" in existing) {
      if (compareHlc(/** @type {{ _hlc: HlcTuple }} */ (existing)._hlc, hlcTuple) > 0) {
        return;
      }
    }
    replica.set(entityKey, { value, _hlc: hlcTuple });
  };

  if (op === "context_create") {
    const id = String(m.payload?.context_id ?? contextId);
    setIfNewer(`ctx:${id}`, { deleted: false, metadata: m.payload?.metadata ?? {} });
  }
  if (op === "message_append" || op === "message_update") {
    const rows = Array.isArray(m.payload?.messages) ? m.payload.messages : [];
    for (const msg of rows) {
      const cid = msg?.metadata?.ic_client_node_id ?? msg?.id;
      if (cid) setIfNewer(`msg:${cid}`, msg);
    }
  }
  if (op === "message_delete") {
    const ids = Array.isArray(m.payload?.ids) ? m.payload.ids : [m.payload?.ids];
    for (const id of ids) {
      if (id === undefined || id === null) continue;
      const entityKey = `msg:${String(id)}`;
      const existing = replica.get(entityKey);
      if (existing && typeof existing === "object" && existing !== null && "_hlc" in existing) {
        if (compareHlc(/** @type {{ _hlc: HlcTuple }} */ (existing)._hlc, hlcTuple) > 0) {
          continue;
        }
      }
      replica.delete(entityKey);
    }
  }
}

/**
 * Apply sorted mutations to a replica map (LWW by HLC).
 * @param {Map<string, unknown>} replica
 * @param {MergeableMutation[]} sorted
 */
export function applySortedMutationsToReplica(replica, sorted) {
  for (const row of sorted) {
    applyMergeableMutationToReplica(replica, row);
  }
}

/**
 * @param {MergeableMutation[]} items
 * @param {number} splits number of random batch boundaries to simulate
 */
export function permuteMutationBatches(items, splits = 3) {
  const sorted = sortMergeableMutations(items);
  if (sorted.length <= 1) return [sorted];
  /** @type {MergeableMutation[][]} */
  const batches = [];
  let start = 0;
  for (let i = 0; i < splits; i += 1) {
    const at = Math.min(sorted.length, start + Math.ceil(sorted.length / (splits + 1)));
    if (at > start) batches.push(sorted.slice(start, at));
    start = at;
  }
  if (start < sorted.length) batches.push(sorted.slice(start));
  return batches.length ? batches : [sorted];
}

/** @param {Map<string, unknown>} replica */
export function replicaSnapshot(replica) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, wrapped] of replica.entries()) {
    if (wrapped && typeof wrapped === "object" && "value" in wrapped) {
      out[key] = /** @type {{ value: unknown }} */ (wrapped).value;
    }
  }
  return out;
}

/**
 * @param {MergeableMutation[]} items
 * @returns {MergeableMutation[]}
 */
export function shuffleMutations(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
