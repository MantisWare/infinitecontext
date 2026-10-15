import { applySyncChangeToReplica, createEmptySyncReplica } from "./sync-replica-apply.mjs";
import {
  hydrateSyncReplica,
  sanitizeSyncReplicaForPersist,
} from "./sync-replica-state.mjs";

/** @param {unknown} change */
export function isObjectStoreSyncChange(change) {
  if (!change || typeof change !== "object") return false;
  const hlc = /** @type {Record<string, unknown>} */ (change).hlc;
  return hlc !== null && hlc !== undefined && typeof hlc === "object";
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ upsertSyncReplica: { run: (...args: unknown[]) => unknown }, getSyncReplica: { get: (...args: unknown[]) => { replica_json?: string } | undefined } }} stmt
 */
export function createDaemonSyncReplicaPersistence(db, stmt) {
  /** @type {Record<string, unknown> | null} */
  let cachedReplica = null;

  /** @param {Record<string, unknown>} replica */
  function flushSyncReplicaTxn(replica) {
    const sanitized = sanitizeSyncReplicaForPersist(replica);
    db.exec("BEGIN");
    try {
      const json = JSON.stringify(sanitized);
      stmt.upsertSyncReplica.run(json);
      db.exec("COMMIT");
      cachedReplica = hydrateSyncReplica(JSON.parse(json));
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    loadSyncReplica() {
      if (cachedReplica) return cachedReplica;
      const row = stmt.getSyncReplica.get();
      if (!row?.replica_json) {
        cachedReplica = createEmptySyncReplica();
        return cachedReplica;
      }
      cachedReplica = hydrateSyncReplica(JSON.parse(String(row.replica_json)));
      return cachedReplica;
    },
    flushSyncReplica(replica) {
      flushSyncReplicaTxn(replica);
    },
    /** @param {Record<string, unknown>} change @param {(change: Record<string, unknown>) => void} applyHostedChange */
    applyObjectStoreSyncChange(change, applyHostedChange) {
      if (!isObjectStoreSyncChange(change)) {
        applyHostedChange(change);
        return;
      }
      const replica = this.loadSyncReplica();
      applySyncChangeToReplica(replica, change, () => {});
      flushSyncReplicaTxn(replica);
    },
    clearReplicaCache() {
      cachedReplica = null;
    },
  };
}
