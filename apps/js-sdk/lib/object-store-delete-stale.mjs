import { normalizeVectorSyncCursor } from "./sync-cursor.mjs";

/**
 * Hosted-style stale delete using per-device vector cursor at plan time.
 * Conflicts when a target message has message_append/update from (devH, seq) with seq > base[devH].
 * Missing base[devH] is treated as none seen (-1).
 *
 * @param {object[]} ledger
 * @param {import('./sync-cursor.mjs').VectorSyncCursor | Record<string, number>} planBaseVector
 * @param {string[]} targetClientIds
 */
export function hasMessageUpdateSinceVectorBase(ledger, planBaseVector, targetClientIds) {
  const targets = new Set(targetClientIds);
  const base =
    planBaseVector && typeof planBaseVector === "object" && planBaseVector.kind === "vector"
      ? planBaseVector.v ?? {}
      : /** @type {Record<string, number>} */ (planBaseVector ?? {});
  for (const row of ledger) {
    const op = String(row.op ?? "");
    if (op !== "message_update" && op !== "message_append") continue;
    const devH = row.sourceDevH ? String(row.sourceDevH) : "";
    const seq = Number(row.sourceSeq);
    if (!devH || !Number.isSafeInteger(seq) || seq < 0) continue;
    const threshold = Object.prototype.hasOwnProperty.call(base, devH) ? Number(base[devH]) : 0;
    if (seq <= threshold) continue;
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    const ids = [];
    if (Array.isArray(payload.affected_client_ids)) ids.push(...payload.affected_client_ids);
    if (row.clientNodeId) ids.push(row.clientNodeId);
    if (Array.isArray(payload.messages)) {
      for (const msg of payload.messages) {
        const cid = msg?.metadata?.ic_client_node_id ?? msg?.id;
        if (cid) ids.push(String(cid));
      }
    }
    for (const id of ids) {
      if (typeof id === "string" && targets.has(id)) return true;
    }
  }
  return false;
}

/** @param {import('./sync-cursor.mjs').VectorSyncCursor} cursor */
export function snapshotVectorCursor(cursor) {
  const normalized = normalizeVectorSyncCursor(cursor);
  return { kind: "vector", v: { ...normalized.v } };
}

/**
 * Deterministic delete_stale_base conflict record (same on every device).
 * @param {object} input
 */
export function buildDeleteStaleBaseConflict(input) {
  const clientId = String(input.client_id ?? "");
  const contextId = String(input.context_id ?? "");
  const baseVector = snapshotVectorCursor(input.base_vector ?? { kind: "vector", v: {} });
  const targets = Array.isArray(input.delete_targets) ? input.delete_targets.map(String) : [];
  const headSum = Object.values(baseVector.v).reduce((a, b) => a + Number(b), 0);
  return {
    id: `delete_stale_base:${contextId}:${clientId}`,
    context_id: contextId,
    kind: "delete_stale_base",
    client_id: clientId,
    sequence: headSum + 1,
    left_payload: {
      base_vector: baseVector,
      base_sequence: headSum,
      server_sequence: headSum,
      op: "message_delete",
    },
    right_payload: { delete_targets: targets },
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: null,
  };
}
