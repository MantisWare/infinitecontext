/**
 * @typedef {Object} MergeableMutation
 * @property {string} hlc
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
  const h = String(a.hlc).localeCompare(String(b.hlc));
  if (h !== 0) return h;
  const d = a.devH.localeCompare(b.devH);
  if (d !== 0) return d;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.index - b.index;
}

/**
 * @param {MergeableMutation[]} items
 */
export function sortMergeableMutations(items) {
  return [...items].sort(compareMergeableMutations);
}

/**
 * Apply sorted mutations to a replica map (contexts/messages) for property tests.
 * @param {Map<string, unknown>} replica
 * @param {MergeableMutation[]} sorted
 */
export function applySortedMutationsToReplica(replica, sorted) {
  for (const row of sorted) {
    const m = row.mutation;
    if (!m || typeof m !== "object") continue;
    const op = String(m.op ?? "");
    const contextId = m.context_id ? String(m.context_id) : "";
    if (op === "context_create") {
      const id = String(m.payload?.context_id ?? contextId);
      replica.set(`ctx:${id}`, { deleted: false, metadata: m.payload?.metadata ?? {} });
    }
    if (op === "message_append" || op === "message_update") {
      const rows = Array.isArray(m.payload?.messages) ? m.payload.messages : [];
      for (const msg of rows) {
        const cid = msg?.metadata?.ic_client_node_id ?? msg?.id;
        if (cid) replica.set(`msg:${cid}`, msg);
      }
    }
    if (op === "message_delete") {
      const ids = Array.isArray(m.payload?.ids) ? m.payload.ids : [m.payload?.ids];
      for (const id of ids) {
        if (id !== undefined && id !== null) replica.delete(`msg:${String(id)}`);
      }
    }
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
