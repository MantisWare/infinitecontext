/**
 * Idempotent conflict id: (messageId, loser devH, loser seq, index) — kind is not part of the id.
 * @param {string} messageId
 * @param {string} loserDevH
 * @param {number} loserSeq
 * @param {number} loserIndex
 */
export function replicaConflictId(messageId, loserDevH, loserSeq, loserIndex) {
  const devH = String(loserDevH ?? "UNKNOWN");
  const seq = Number.isSafeInteger(loserSeq) ? loserSeq : 0;
  const index = Number.isSafeInteger(loserIndex) ? loserIndex : 0;
  return `${messageId}:${devH}:${seq}:${index}`;
}

/**
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 */
export function conflictKindForReplicaMessage(replica, messageId) {
  const msg = replica.messages?.[messageId];
  if (msg && typeof msg === "object" && msg.tombstone === true) {
    return "tombstone_blocked_update";
  }
  return "lww_superseded";
}

/**
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 */
export function refreshReplicaConflictKindsForMessage(replica, messageId) {
  if (!Array.isArray(replica.sync_conflicts)) return;
  const kind = conflictKindForReplicaMessage(replica, messageId);
  for (const row of replica.sync_conflicts) {
    if (String(row.client_id ?? "") !== messageId) continue;
    row.kind = kind;
    if (kind === "tombstone_blocked_update") {
      row.left_payload = {
        tombstone: true,
        deleted_client_ids: [messageId],
        op: "message_delete",
      };
    }
  }
}

/**
 * Upsert a loser conflict; kind follows the message's current replica state.
 * @param {Record<string, unknown>} replica
 * @param {object} input
 */
export function upsertReplicaLoserConflict(replica, input) {
  const contextId = String(input.context_id ?? "");
  const messageId = String(input.client_node_id ?? "");
  const loserDevH = String(input.loser_dev_h ?? input.source_dev_h ?? "");
  const loserSeq = Number(input.loser_seq ?? input.source_seq ?? 0);
  const loserIndex = Number(input.loser_index ?? input.source_index ?? 0);
  const id = replicaConflictId(messageId, loserDevH, loserSeq, loserIndex);
  const kind = conflictKindForReplicaMessage(replica, messageId);
  const op = String(input.op ?? "message_update");
  /** @type {Record<string, unknown>} */
  const next = {
    id,
    context_id: contextId,
    kind,
    client_id: messageId,
    sequence: Number(input.sequence ?? 0),
    right_payload: {
      op,
      hlc: input.loser_hlc ?? input.hlc ?? null,
      data: input.data ?? null,
      source_dev_h: loserDevH,
      source_seq: loserSeq,
      source_index: loserIndex,
    },
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: null,
  };
  if (kind === "tombstone_blocked_update") {
    next.left_payload = {
      tombstone: true,
      deleted_client_ids: [messageId],
      op: "message_delete",
    };
  } else {
    next.left_payload = { winner_hlc: input.winner_hlc ?? null };
  }
  if (!Array.isArray(replica.sync_conflicts)) replica.sync_conflicts = [];
  const idx = replica.sync_conflicts.findIndex((row) => row.id === id);
  if (idx >= 0) {
    next.created_at = replica.sync_conflicts[idx].created_at ?? next.created_at;
    replica.sync_conflicts[idx] = next;
  } else {
    replica.sync_conflicts.push(next);
  }
}
