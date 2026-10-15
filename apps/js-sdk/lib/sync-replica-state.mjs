import { ObjectStoreSyncStateError } from "./object-store-state-errors.mjs";
import { createEmptySyncReplica } from "./sync-replica-apply.mjs";

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
  validateMessageMutationLog(replica);
  rebuildMutationLogIndex(replica);
  return replica;
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

/** @param {Record<string, unknown>} replica */
export function sanitizeSyncReplicaForPersist(replica) {
  const out = {
    contexts: replica.contexts ?? {},
    messages: { ...(replica.messages ?? {}) },
    sync_conflicts: Array.isArray(replica.sync_conflicts) ? replica.sync_conflicts : [],
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
      const conflictIds = new Set(
        (out.sync_conflicts ?? [])
          .filter((c) => String(c?.client_id ?? "") === messageId)
          .map((c) => String(c?.id ?? "")),
      );
      out._message_mutations[messageId] = entries.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const row = { .../** @type {Record<string, unknown>} */ (entry) };
        const entryConflictId = `${messageId}:${row.devH}:${row.seq}:${row.index ?? 0}`;
        if (!conflictIds.has(entryConflictId)) row.data = null;
        return row;
      });
    }
  }
  return out;
}
