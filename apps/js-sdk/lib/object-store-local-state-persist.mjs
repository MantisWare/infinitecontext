import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createEmptyObjectStoreLocalSyncState,
  mergeTrustedHeadsForwardOnly,
} from "./object-store-local-sync-state.mjs";
import { normalizeVectorSyncCursor, serializeVectorSyncCursor } from "./sync-cursor.mjs";

/** @param {unknown} raw */
export function hydrateObjectStoreLocalSyncState(raw) {
  const base = createEmptyObjectStoreLocalSyncState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return base;
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  return {
    ...base,
    selfNextSeq: Number(record.selfNextSeq ?? base.selfNextSeq),
    trustedHeads:
      record.trustedHeads && typeof record.trustedHeads === "object"
        ? { ...base.trustedHeads, ...record.trustedHeads }
        : base.trustedHeads,
    vectorCursor: normalizeVectorSyncCursor(record.vectorCursor ?? base.vectorCursor),
    ledger: Array.isArray(record.ledger) ? record.ledger : base.ledger,
    conflicts: Array.isArray(record.conflicts) ? record.conflicts : base.conflicts,
    changeOrdinal: Number(record.changeOrdinal ?? base.changeOrdinal),
    localHlc:
      record.localHlc && typeof record.localHlc === "object"
        ? {
            wall_ms: Number(record.localHlc.wall_ms ?? 0),
            counter: Number(record.localHlc.counter ?? 0),
          }
        : base.localHlc,
    logListCursor: typeof record.logListCursor === "string" ? record.logListCursor : base.logListCursor,
  };
}

/** @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state */
export function serializeObjectStoreLocalSyncState(state) {
  return {
    selfNextSeq: state.selfNextSeq,
    trustedHeads: state.trustedHeads,
    vectorCursor: normalizeVectorSyncCursor(state.vectorCursor),
    ledger: state.ledger,
    conflicts: state.conflicts,
    changeOrdinal: state.changeOrdinal,
    localHlc: state.localHlc,
    logListCursor: state.logListCursor ?? "",
  };
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} persisted
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} incoming
 */
export function mergeObjectStoreLocalSyncState(persisted, incoming) {
  mergeTrustedHeadsForwardOnly(persisted, incoming);
  persisted.selfNextSeq = Math.max(persisted.selfNextSeq, incoming.selfNextSeq);
  persisted.vectorCursor = normalizeVectorSyncCursor(incoming.vectorCursor);
  persisted.ledger = incoming.ledger;
  persisted.conflicts = incoming.conflicts;
  persisted.changeOrdinal = Math.max(persisted.changeOrdinal, incoming.changeOrdinal);
  persisted.localHlc = incoming.localHlc;
  persisted.logListCursor = incoming.logListCursor ?? persisted.logListCursor;
}

/**
 * Atomic JSON file backend (~/.infinitecontext/sync-cli-state.json objectStoreSync field).
 * @param {string} cliStateFilePath
 */
export function createCliFileObjectStoreLocalState(cliStateFilePath) {
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(cliStateFilePath, "utf8"));
        return hydrateObjectStoreLocalSyncState(parsed.objectStoreSync ?? parsed);
      } catch {
        return createEmptyObjectStoreLocalSyncState();
      }
    },
    save(incoming) {
      const dir = path.dirname(cliStateFilePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      let envelope = { cursor: 0 };
      try {
        envelope = JSON.parse(fs.readFileSync(cliStateFilePath, "utf8"));
      } catch {
        // fresh file
      }
      const persisted = hydrateObjectStoreLocalSyncState(envelope.objectStoreSync);
      mergeObjectStoreLocalSyncState(persisted, incoming);
      envelope.objectStoreSync = serializeObjectStoreLocalSyncState(persisted);
      const tmp = `${cliStateFilePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
      const fd = fs.openSync(tmp, "r+");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, cliStateFilePath);
    },
  };
}

/**
 * SQLite backend (daemon.db) with transactional writes.
 * @param {string} dbPath
 */
export function createDaemonDbObjectStoreLocalState(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec(`
    CREATE TABLE IF NOT EXISTS object_store_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL
    );
  `);
  const getRow = db.prepare("SELECT state_json FROM object_store_sync_state WHERE id = 1");
  const upsert = db.prepare(`
    INSERT INTO object_store_sync_state (id, state_json) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json
  `);

  return {
    load() {
      const row = getRow.get();
      if (!row?.state_json) return createEmptyObjectStoreLocalSyncState();
      try {
        return hydrateObjectStoreLocalSyncState(JSON.parse(String(row.state_json)));
      } catch {
        return createEmptyObjectStoreLocalSyncState();
      }
    },
    save(incoming) {
      db.exec("BEGIN");
      try {
        const row = getRow.get();
        const persisted = row?.state_json
          ? hydrateObjectStoreLocalSyncState(JSON.parse(String(row.state_json)))
          : createEmptyObjectStoreLocalSyncState();
        mergeObjectStoreLocalSyncState(persisted, incoming);
        upsert.run(JSON.stringify(serializeObjectStoreLocalSyncState(persisted)));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}

export { serializeVectorSyncCursor };
