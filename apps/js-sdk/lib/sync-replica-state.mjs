import { ObjectStoreSyncStateError } from "./object-store-state-errors.mjs";
import { createEmptySyncReplica } from "./sync-replica-apply.mjs";
import {
  isMessageSourceCoveredByVectorBase,
  replicaConflictId,
} from "./object-store-replica-conflicts.mjs";

/** @param {unknown} raw */
export function hydrateSyncReplica(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptySyncReplica();
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const replica = {
    contexts: obj.contexts && typeof obj.contexts === "object" ? { ...obj.contexts } : {},
    messages: obj.messages && typeof obj.messages === "object" ? { ...obj.messages } : {},
    sync_conflicts: Array.isArray(obj.sync_conflicts) ? [...obj.sync_conflicts] : [],
    _message_mutations:
      obj._message_mutations && typeof obj._message_mutations === "object" ? { ...obj._message_mutations } : {},
  };
  restoreMutationLogDataFromConflicts(replica);
  validateMessageMutationLog(replica);
  rebuildMutationLogIndex(replica);
  return replica;
}

/** @param {Record<string, unknown>} replica */
function restoreMutationLogDataFromConflicts(replica) {
  const log = replica._message_mutations;
  if (!log || typeof log !== "object" || !Array.isArray(replica.sync_conflicts)) return;
  for (const conflict of replica.sync_conflicts) {
    if (!conflict || typeof conflict !== "object") continue;
    const messageId = String(conflict.client_id ?? "");
    const right = conflict.right_payload;
    if (!messageId || !right || typeof right !== "object") continue;
    const data = /** @type {Record<string, unknown>} */ (right).data;
    if (data === null || data === undefined) continue;
    const devH = String(/** @type {Record<string, unknown>} */ (right).source_dev_h ?? "");
    const seq = Number(/** @type {Record<string, unknown>} */ (right).source_seq ?? 0);
    const index = Number(/** @type {Record<string, unknown>} */ (right).source_index ?? 0);
    const entries = log[messageId];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (entry);
      if (String(row.devH) === devH && Number(row.seq) === seq && Number(row.index ?? 0) === index) {
        if (row.data === null || row.data === undefined) row.data = data;
      }
    }
  }
}

/** @param {Record<string, unknown>} replica */
export function validateMessageMutationLog(replica) {
  const log = replica._message_mutations;
  if (log === undefined) return;
  if (log === null || typeof log !== "object" || Array.isArray(log)) {
    throw new ObjectStoreSyncStateError("Corrupt sync replica mutation log", "corrupt_state");
  }
  for (const entries of Object.values(log)) {
    if (!Array.isArray(entries)) {
      throw new ObjectStoreSyncStateError("Corrupt sync replica mutation log entry list", "corrupt_state");
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        throw new ObjectStoreSyncStateError("Corrupt sync replica mutation log entry", "corrupt_state");
      }
      const row = /** @type {Record<string, unknown>} */ (entry);
      if (typeof row.devH !== "string" || !Number.isSafeInteger(Number(row.seq))) {
        throw new ObjectStoreSyncStateError("Corrupt sync replica mutation log coordinates", "corrupt_state");
      }
      if (!row.hlc || typeof row.hlc !== "object") {
        throw new ObjectStoreSyncStateError("Corrupt sync replica mutation log hlc", "corrupt_state");
      }
    }
  }
}

/** @param {Record<string, unknown>} replica */
export function rebuildMutationLogIndex(replica) {
  /** @type {Record<string, Set<string>>} */
  const index = {};
  const log = replica._message_mutations;
  if (!log || typeof log !== "object") {
    replica._mutation_log_ids = index;
    return;
  }
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
  replica._mutation_log_ids = index;
}

/**
 * @param {Record<string, unknown>} entry
 * @param {Record<string, unknown> | null | undefined} baseVector
 */
function entryUncoveredByBaseVector(entry, baseVector) {
  if (!baseVector) return false;
  return !isMessageSourceCoveredByVectorBase(
    { devH: String(entry.devH), seq: Number(entry.seq) },
    baseVector,
  );
}

/** @param {Record<string, unknown>} entry */
function mutationLogEntryKey(entry) {
  return `${String(entry.devH)}:${Number(entry.seq)}:${Number(entry.index ?? 0)}`;
}

/**
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 * @param {Record<string, unknown>} entry
 * @param {Record<string, unknown>[]} sortedEntries
 */
function mutationLogEntryRetainsData(replica, messageId, entry, sortedEntries) {
  const msgState = replica.messages?.[messageId];
  if (msgState && typeof msgState === "object" && msgState.tombstone) {
    return false;
  }
  const conflictId = replicaConflictId(messageId, String(entry.devH), Number(entry.seq), Number(entry.index ?? 0));
  const hasConflict = (replica.sync_conflicts ?? []).some((c) => String(c?.id ?? "") === conflictId);
  if (hasConflict) return true;

  const msg = replica.messages?.[messageId];
  if (msg && typeof msg === "object" && !msg.tombstone && msg._source) {
    const src = /** @type {{ devH?: string, seq?: number, index?: number }} */ (msg._source);
    if (
      String(src.devH) === String(entry.devH) &&
      Number(src.seq) === Number(entry.seq) &&
      Number(src.index ?? 0) === Number(entry.index ?? 0)
    ) {
      return true;
    }
  }

  const key = mutationLogEntryKey(entry);
  let entryIdx = -1;
  for (let i = 0; i < sortedEntries.length; i += 1) {
    if (mutationLogEntryKey(sortedEntries[i]) === key) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0) return true;
  for (let i = entryIdx + 1; i < sortedEntries.length; i += 1) {
    const later = sortedEntries[i];
    if (!later || typeof later !== "object") continue;
    const base = later.delete_base_vector ?? later.update_base_vector;
    if (entryUncoveredByBaseVector(entry, /** @type {Record<string, unknown>} */ (base))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown>} replica
 * @param {string} messageId
 */
function deleteBaseVectorForTombstone(replica, messageId) {
  const msg = replica.messages?.[messageId];
  if (!msg || typeof msg !== "object" || !msg.tombstone) return null;
  const src = msg._source;
  if (!src || typeof src !== "object") return null;
  const log = replica._message_mutations?.[messageId];
  if (!Array.isArray(log)) return null;
  for (const entry of log) {
    if (!entry || typeof entry !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (entry);
    if (String(row.op ?? "") !== "message_delete") continue;
    if (
      String(row.devH) === String(/** @type {{ devH?: string }} */ (src).devH ?? "") &&
      Number(row.seq) === Number(/** @type {{ seq?: number }} */ (src).seq ?? 0)
    ) {
      const base = row.delete_base_vector;
      return base && typeof base === "object" ? /** @type {Record<string, unknown>} */ (base) : null;
    }
  }
  return null;
}

/** @param {Record<string, unknown>[]} entries */
function sortedMutationLogEntries(entries) {
  return [...entries].sort((a, b) => {
    const aw = Number(a.hlc?.wall_ms ?? 0);
    const bw = Number(b.hlc?.wall_ms ?? 0);
    if (aw !== bw) return aw - bw;
    const ac = Number(a.hlc?.counter ?? 0);
    const bc = Number(b.hlc?.counter ?? 0);
    if (ac !== bc) return ac - bc;
    const ad = String(a.hlc?.devH ?? a.devH ?? "");
    const bd = String(b.hlc?.devH ?? b.devH ?? "");
    if (ad !== bd) return ad.localeCompare(bd);
    return Number(a.index ?? 0) - Number(b.index ?? 0);
  });
}

/** @param {Record<string, unknown>} replica */
export function sanitizeSyncReplicaForPersist(replica) {
  const out = {
    contexts: replica.contexts ?? {},
    messages: { ...(replica.messages ?? {}) },
    sync_conflicts: Array.isArray(replica.sync_conflicts)
      ? replica.sync_conflicts.map((row) => {
          if (!row || typeof row !== "object") return row;
          if (String(row.kind ?? "") !== "tombstone_blocked_update") return row;
          const messageId = String(row.client_id ?? "");
          const right = row.right_payload;
          if (!right || typeof right !== "object") return row;
          const deleteBase = deleteBaseVectorForTombstone(replica, messageId);
          if (!deleteBase) return row;
          const loserSource = {
            devH: String(/** @type {Record<string, unknown>} */ (right).source_dev_h ?? ""),
            seq: Number(/** @type {Record<string, unknown>} */ (right).source_seq ?? 0),
          };
          if (!isMessageSourceCoveredByVectorBase(loserSource, deleteBase)) {
            return row;
          }
          return {
            ...row,
            right_payload: { .../** @type {Record<string, unknown>} */ (right), data: null },
          };
        })
      : [],
    _message_mutations: {},
  };
  for (const [key, msg] of Object.entries(out.messages)) {
    if (msg && typeof msg === "object" && /** @type {{ tombstone?: boolean }} */ (msg).tombstone) {
      const copy = { .../** @type {Record<string, unknown>} */ (msg) };
      delete copy.payload;
      out.messages[key] = copy;
    }
  }
  const log = replica._message_mutations;
  if (log && typeof log === "object") {
    for (const [messageId, entries] of Object.entries(log)) {
      if (!Array.isArray(entries)) continue;
      const sorted = sortedMutationLogEntries(entries);
      out._message_mutations[messageId] = entries.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const row = { .../** @type {Record<string, unknown>} */ (entry) };
        if (mutationLogEntryRetainsData(replica, messageId, row, sorted)) return row;
        row.data = null;
        return row;
      });
    }
  }
  return out;
}

/** @param {unknown} err */
export function wrapReplicaJsonParseError(err) {
  if (err instanceof ObjectStoreSyncStateError) throw err;
  throw new ObjectStoreSyncStateError("Corrupt sync replica JSON", "corrupt_state");
}
