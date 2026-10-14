/**
 * Idempotent conflict id: (messageId, loser devH, loser seq, index).
 * @param {string} kind
 * @param {string} messageId
 * @param {string} loserDevH
 * @param {number} loserSeq
 * @param {number} loserIndex
 */
export function replicaConflictId(kind, messageId, loserDevH, loserSeq, loserIndex) {
  const devH = String(loserDevH ?? "UNKNOWN");
  const seq = Number.isSafeInteger(loserSeq) ? loserSeq : 0;
  const index = Number.isSafeInteger(loserIndex) ? loserIndex : 0;
  return `${kind}:${messageId}:${devH}:${seq}:${index}`;
}

/**
 * @param {object} input
 */
export function buildTombstoneBlockedUpdateConflict(input) {
  const contextId = String(input.context_id ?? "");
  const messageId = String(input.client_node_id ?? "");
  const loserDevH = String(input.loser_dev_h ?? input.source_dev_h ?? "");
  const loserSeq = Number(input.loser_seq ?? input.source_seq ?? 0);
  const loserIndex = Number(input.loser_index ?? input.source_index ?? 0);
  const op = String(input.op ?? "message_update");
  return {
    id: replicaConflictId("tombstone_blocked", messageId, loserDevH, loserSeq, loserIndex),
    context_id: contextId,
    kind: "tombstone_blocked_update",
    client_id: messageId,
    sequence: Number(input.sequence ?? 0),
    left_payload: {
      tombstone: true,
      deleted_client_ids: [messageId],
      op: "message_delete",
    },
    right_payload: {
      op,
      hlc: input.hlc ?? null,
      data: input.data ?? null,
      source_dev_h: loserDevH,
      source_seq: loserSeq,
      source_index: loserIndex,
    },
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: null,
  };
}

/**
 * @param {object} input
 */
export function buildLwwSupersededConflict(input) {
  const contextId = String(input.context_id ?? "");
  const messageId = String(input.client_node_id ?? "");
  const loserDevH = String(input.loser_dev_h ?? "");
  const loserSeq = Number(input.loser_seq ?? 0);
  const loserIndex = Number(input.loser_index ?? 0);
  return {
    id: replicaConflictId("lww_superseded", messageId, loserDevH, loserSeq, loserIndex),
    context_id: contextId,
    kind: "lww_superseded",
    client_id: messageId,
    sequence: Number(input.sequence ?? 0),
    left_payload: { winner_hlc: input.winner_hlc ?? null },
    right_payload: {
      op: input.op,
      hlc: input.loser_hlc ?? null,
      data: input.data ?? null,
      source_dev_h: loserDevH,
      source_seq: loserSeq,
      source_index: loserIndex,
    },
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: null,
  };
}
