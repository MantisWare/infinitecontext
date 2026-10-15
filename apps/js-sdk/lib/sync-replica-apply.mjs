import { compareHlc, HLC_MAX_SKEW_MS, normalizeMutationHlc } from "./object-store-hlc.mjs";
import { recordMessageMutationLog, recomputeReplicaConflictsForMessage } from "./object-store-replica-conflicts.mjs";

/** @returns {{ contexts: Record<string, unknown>, messages: Record<string, unknown>, sync_conflicts: object[], _message_mutations: Record<string, unknown> }} */
export function createEmptySyncReplica() {
  return {
    contexts: {},
    messages: {},
    sync_conflicts: [],
    _message_mutations: {},
  };
}

/** @param {Record<string, unknown>} change */
function changeHlcTuple(change) {
  const devH = change.source_dev_h ? String(change.source_dev_h) : "UNKNOWN";
  const index = Number(change.source_index ?? 0);
  return normalizeMutationHlc(change.hlc, devH, index);
}

/** @param {Record<string, unknown> | undefined} existing @param {import('./object-store-hlc.mjs').HlcTuple} incoming */
function shouldApplyLww(existing, incoming) {
  if (!existing || typeof existing !== "object" || !existing._hlc) return true;
  return compareHlc(/** @type {{ _hlc: import('./object-store-hlc.mjs').HlcTuple }} */ (existing)._hlc, incoming) <= 0;
}

/**
 * @param {Record<string, unknown>} replica
 * @param {Record<string, unknown>} change
 * @param {(replica: Record<string, unknown>) => void} persist
 */
export function applySyncChangeToReplica(replica, change, persist) {
  if (!change || typeof change !== "object") return;
  const op = String(change.op ?? "");
  const contextId = change.context_id ? String(change.context_id) : "";
  const payload = change.payload && typeof change.payload === "object" ? change.payload : {};
  const sequence = Number(change.sequence ?? 0);
  const hlcTuple = change.hlc ? changeHlcTuple(change) : null;
  if (hlcTuple && hlcTuple.wall_ms > Date.now() + HLC_MAX_SKEW_MS) {
    return;
  }

  if (op === "context_create" || op === "context_fork" || op === "context_metadata") {
    const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : payload;
    const id = String(payload.context_id ?? contextId ?? "");
    if (id) {
      const existing = replica.contexts[id];
      if (!hlcTuple || shouldApplyLww(existing, hlcTuple)) {
        replica.contexts[id] = { metadata: meta, sequence, deleted: false, _hlc: hlcTuple ?? undefined };
      }
    }
    persist(replica);
    return;
  }

  if (op === "context_delete") {
    const id = String(payload.context_id ?? contextId ?? "");
    if (id) replica.contexts[id] = { ...(replica.contexts[id] ?? {}), deleted: true, sequence };
    persist(replica);
    return;
  }

  if (op === "contexts_delete_many") {
    const results = Array.isArray(payload.results) ? payload.results : [];
    for (const row of results) {
      if (row?.deleted !== true) continue;
      const id = String(row?.id ?? row?.context_id ?? "");
      if (id) replica.contexts[id] = { ...(replica.contexts[id] ?? {}), deleted: true, sequence };
    }
    persist(replica);
    return;
  }

  const changeSource = {
    devH: change.source_dev_h ? String(change.source_dev_h) : "",
    seq: Number(change.source_seq ?? 0),
    index: Number(change.source_index ?? 0),
  };
  const updateBase = change.base_vector ?? payload.base_vector ?? null;

  if (op === "message_append" || op === "message_update") {
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const clientNodeId = row.metadata?.ic_client_node_id ?? row.id;
      if (!clientNodeId) continue;
      const key = String(clientNodeId);
      const existing = replica.messages[key];
      const ctxId = String(payload.context_id ?? contextId);

      if (!hlcTuple) {
        replica.messages[key] = {
          context_id: ctxId,
          payload: row,
          sequence,
          op,
        };
        continue;
      }

      recordMessageMutationLog(replica, key, {
        context_id: ctxId,
        op,
        hlc: hlcTuple,
        data: row,
        devH: changeSource.devH,
        seq: changeSource.seq,
        index: changeSource.index,
        update_base_vector: updateBase,
      });

      if (existing?.tombstone) {
        recomputeReplicaConflictsForMessage(replica, key);
        continue;
      }

      if (existing?._hlc && !shouldApplyLww(existing, hlcTuple)) {
        recomputeReplicaConflictsForMessage(replica, key);
        continue;
      }

      replica.messages[key] = {
        context_id: ctxId,
        payload: row,
        sequence,
        op,
        tombstone: false,
        _hlc: hlcTuple,
        _source: { ...changeSource },
      };
      recomputeReplicaConflictsForMessage(replica, key);
    }
    persist(replica);
    return;
  }

  if (op === "message_delete") {
    const deletedIds = Array.isArray(payload.deleted_client_ids) ? payload.deleted_client_ids : [];
    const deleteBase = change.base_vector ?? payload.base_vector ?? null;
    for (const id of deletedIds) {
      if (!id) continue;
      const key = String(id);
      const ctxId = String(payload.context_id ?? contextId);
      if (!hlcTuple) {
        delete replica.messages[key];
        continue;
      }
      recordMessageMutationLog(replica, key, {
        context_id: ctxId,
        op: "message_delete",
        hlc: hlcTuple,
        data: null,
        devH: changeSource.devH,
        seq: changeSource.seq,
        index: changeSource.index,
        delete_base_vector: deleteBase,
      });
      replica.messages[key] = {
        context_id: ctxId,
        tombstone: true,
        sequence,
        deleted_at: change.created_at ?? new Date().toISOString(),
        _hlc: hlcTuple,
        _source: { ...changeSource },
      };
      recomputeReplicaConflictsForMessage(replica, key);
    }
    persist(replica);
  }
}
