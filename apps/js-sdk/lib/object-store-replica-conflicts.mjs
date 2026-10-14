/**
 * Deterministic replica conflict when an update loses to a permanent delete tombstone.
 * @param {object} input
 */
export function buildTombstoneBlockedUpdateConflict(input) {
  const contextId = String(input.context_id ?? "");
  const clientNodeId = String(input.client_node_id ?? "");
  const op = String(input.op ?? "message_update");
  return {
    id: `tombstone_blocked:${contextId}:${clientNodeId}:${op}`,
    context_id: contextId,
    kind: "tombstone_blocked_update",
    client_id: clientNodeId,
    sequence: Number(input.sequence ?? 0),
    left_payload: {
      tombstone: true,
      deleted_client_ids: [clientNodeId],
      op: "message_delete",
    },
    right_payload: {
      op,
      hlc: input.hlc ?? null,
      data: input.data ?? null,
      message: input.message ?? null,
    },
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: null,
  };
}

/**
 * When LWW would drop an update but neither side is tombstone — preserve losing payload.
 * @param {object} input
 */
export function buildLwwSupersededConflict(input) {
  const contextId = String(input.context_id ?? "");
  const clientNodeId = String(input.client_node_id ?? "");
  return {
    id: `lww_superseded:${contextId}:${clientNodeId}`,
    context_id: contextId,
    kind: "lww_superseded",
    client_id: clientNodeId,
    sequence: Number(input.sequence ?? 0),
    left_payload: { winner_hlc: input.winner_hlc ?? null },
    right_payload: {
      op: input.op,
      hlc: input.loser_hlc ?? null,
      data: input.data ?? null,
    },
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: null,
  };
}
