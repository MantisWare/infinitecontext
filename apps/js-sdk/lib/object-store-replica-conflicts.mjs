import { compareHlc, serializeMutationHlc } from "./object-store-hlc.mjs";
import { normalizeVectorSyncCursor } from "./sync-cursor.mjs";

/**
 * @typedef {Object} MessageMutationLogEntry
 * @property {string} context_id
 * @property {string} op
 * @property {import('./object-store-hlc.mjs').HlcTuple} hlc
 * @property {unknown} data
 * @property {string} devH
 * @property {number} seq
 * @property {number} index
 * @property {import('./sync-cursor.mjs').VectorSyncCursor | Record<string, unknown> | null} [delete_base_vector]
 */

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

/** @param {import('./object-store-hlc.mjs').HlcTuple | null | undefined} hlc */
function createdAtFromLoserHlc(hlc) {
  if (!hlc || typeof hlc !== "object") return "1970-01-01T00:00:00.000Z";
  const wall = Number(hlc.wall_ms);
  if (!Number.isFinite(wall)) return "1970-01-01T00:00:00.000Z";
  return new Date(wall).toISOString();
}

/** @param {import('./object-store-hlc.mjs').HlcTuple | null | undefined} hlc */
function hlcPayload(hlc) {
  if (!hlc || typeof hlc !== "object") return null;
  return serializeMutationHlc(hlc);
}

/**
 * @param {Record<string, unknown>} replica
 * @param {Record<string, unknown>} row
 */
export function refreshReplicaConflictRow(replica, row) {
  const messageId = String(row.client_id ?? "");
  const kind = conflictKindForReplicaMessage(replica, messageId);
  const msg = replica.messages?.[messageId];
  const winnerHlc =
    msg && typeof msg === "object" && msg._hlc && typeof msg._hlc === "object"
      ? /** @type {import('./object-store-hlc.mjs').HlcTuple} */ (msg._hlc)
      : null;
  const right = row.right_payload && typeof row.right_payload === "object" ? row.right_payload : {};
  row.kind = kind;
  row.sequence = Number(right.source_seq ?? 0);
  row.created_at = createdAtFromLoserHlc(
    right.hlc && typeof right.hlc === "object"
      ? /** @type {import('./object-store-hlc.mjs').HlcTuple} */ (right.hlc)
      : null,
  );
  if (kind === "tombstone_blocked_update") {
    row.left_payload = {
      tombstone: true,
      deleted_client_ids: [messageId],
      op: "message_delete",
    };
  } else {
    row.left_payload = { winner_hlc: hlcPayload(winnerHlc) };
  }
}

/**
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 */
export function refreshReplicaConflictsForMessage(replica, messageId) {
  if (!Array.isArray(replica.sync_conflicts)) return;
  for (const row of replica.sync_conflicts) {
    if (String(row.client_id ?? "") === messageId) refreshReplicaConflictRow(replica, row);
  }
}

/**
 * @param {{ devH?: string, seq?: number }} source
 * @param {import('./sync-cursor.mjs').VectorSyncCursor | Record<string, unknown>} planBaseVector
 */
export function isMessageSourceCoveredByVectorBase(source, planBaseVector) {
  const normalized = normalizeVectorSyncCursor(planBaseVector);
  const base = normalized.v ?? {};
  const devH = source.devH ? String(source.devH) : "";
  const seq = Number(source.seq ?? 0);
  if (!devH || !Number.isSafeInteger(seq) || seq < 0) return true;
  const threshold = Object.prototype.hasOwnProperty.call(base, devH) ? Number(base[devH]) : -1;
  return seq <= threshold;
}

/**
 * Upsert a loser conflict; row fields derived from loser coords + final replica state.
 * @param {Record<string, unknown>} replica
 * @param {object} input
 */
/**
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 * @param {MessageMutationLogEntry} entry
 */
export function recordMessageMutationLog(replica, messageId, entry) {
  if (!replica._message_mutations) replica._message_mutations = {};
  const list = /** @type {MessageMutationLogEntry[]} */ (
    replica._message_mutations[messageId] ?? (replica._message_mutations[messageId] = [])
  );
  const id = replicaConflictId(messageId, entry.devH, entry.seq, entry.index);
  if (list.some((m) => replicaConflictId(messageId, m.devH, m.seq, m.index) === id)) return;
  list.push(entry);
}

/** @param {MessageMutationLogEntry} a @param {MessageMutationLogEntry} b */
function compareLogEntry(a, b) {
  return compareHlc(a.hlc, b.hlc);
}

/**
 * Rebuild conflict rows for one message from its mutation log + final replica state.
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 */
export function recomputeReplicaConflictsForMessage(replica, messageId) {
  const entries = [...(/** @type {MessageMutationLogEntry[]} */ (replica._message_mutations?.[messageId] ?? []))].sort(
    compareLogEntry,
  );
  /** @type {MessageMutationLogEntry[]} */
  const losers = [];
  /** @type {MessageMutationLogEntry | null} */
  let winner = null;
  let tombstoned = false;

  for (const entry of entries) {
    if (entry.op === "message_delete") {
      if (winner && !tombstoned) {
        const covered =
          entry.delete_base_vector &&
          isMessageSourceCoveredByVectorBase({ devH: winner.devH, seq: winner.seq }, entry.delete_base_vector);
        if (!covered) losers.push(winner);
      }
      winner = null;
      tombstoned = true;
      continue;
    }
    if (tombstoned) {
      losers.push(entry);
      continue;
    }
    if (!winner) {
      winner = entry;
      continue;
    }
    if (compareHlc(entry.hlc, winner.hlc) > 0) {
      losers.push(winner);
      winner = entry;
    } else {
      losers.push(entry);
    }
  }

  const keepIds = new Set(losers.map((l) => replicaConflictId(messageId, l.devH, l.seq, l.index)));
  if (!Array.isArray(replica.sync_conflicts)) replica.sync_conflicts = [];
  replica.sync_conflicts = replica.sync_conflicts.filter(
    (row) => String(row.client_id ?? "") !== messageId || keepIds.has(String(row.id)),
  );

  for (const loser of losers) {
    upsertReplicaLoserConflict(replica, {
      context_id: loser.context_id,
      client_node_id: messageId,
      op: loser.op,
      loser_hlc: loser.hlc,
      data: loser.data,
      loser_dev_h: loser.devH,
      loser_seq: loser.seq,
      loser_index: loser.index,
    });
  }
}

export function upsertReplicaLoserConflict(replica, input) {
  const contextId = String(input.context_id ?? "");
  const messageId = String(input.client_node_id ?? "");
  const loserDevH = String(input.loser_dev_h ?? input.source_dev_h ?? "");
  const loserSeq = Number(input.loser_seq ?? input.source_seq ?? 0);
  const loserIndex = Number(input.loser_index ?? input.source_index ?? 0);
  const id = replicaConflictId(messageId, loserDevH, loserSeq, loserIndex);
  const op = String(input.op ?? "message_update");
  const loserHlcRaw = input.loser_hlc ?? null;
  const loserHlc =
    loserHlcRaw && typeof loserHlcRaw === "object"
      ? serializeMutationHlc(/** @type {import('./object-store-hlc.mjs').HlcTuple} */ (loserHlcRaw))
      : loserHlcRaw;
  /** @type {Record<string, unknown>} */
  const right_payload = {
    op,
    hlc: loserHlc,
    data: input.data ?? null,
    source_dev_h: loserDevH,
    source_seq: loserSeq,
    source_index: loserIndex,
  };
  if (!Array.isArray(replica.sync_conflicts)) replica.sync_conflicts = [];
  const idx = replica.sync_conflicts.findIndex((row) => row.id === id);
  /** @type {Record<string, unknown>} */
  const row =
    idx >= 0
      ? replica.sync_conflicts[idx]
      : {
          id,
          context_id: contextId,
          client_id: messageId,
          resolved_at: null,
          right_payload,
        };
  row.context_id = contextId;
  row.client_id = messageId;
  row.right_payload = right_payload;
  row.resolved_at = null;
  if (idx < 0) replica.sync_conflicts.push(row);
  refreshReplicaConflictRow(replica, row);
}
