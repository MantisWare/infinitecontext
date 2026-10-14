import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  checkTrustedHeadAdvance,
  createEmptyObjectStoreLocalSyncState,
} from "./object-store-local-sync-state.mjs";
import { ObjectStoreSyncStateError } from "./object-store-state-errors.mjs";
import { advanceVectorCursorDevH, normalizeVectorSyncCursor } from "./sync-cursor.mjs";

/** @param {string} filePath */
function uniqueTmpPath(filePath) {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
}

/** @param {string} lockPath */
function acquireFileLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lockPath, "wx", 0o600);
  fs.writeFileSync(fd, `${process.pid}\n`);
  return fd;
}

/** @param {number} fd @param {string} lockPath */
function releaseFileLock(fd, lockPath) {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/** @param {unknown} raw @param {string} label */
export function hydrateObjectStoreLocalSyncState(raw, label = "object store sync state") {
  if (raw === null || raw === undefined) {
    return createEmptyObjectStoreLocalSyncState();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObjectStoreSyncStateError(`Corrupt ${label}: expected object`, "corrupt_state");
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const base = createEmptyObjectStoreLocalSyncState();
  const selfNextSeq = Number(record.selfNextSeq ?? base.selfNextSeq);
  if (!Number.isSafeInteger(selfNextSeq) || selfNextSeq < 0) {
    throw new ObjectStoreSyncStateError(`Corrupt ${label}: invalid selfNextSeq`, "corrupt_state");
  }
  if (record.trustedHeads !== undefined && (typeof record.trustedHeads !== "object" || Array.isArray(record.trustedHeads))) {
    throw new ObjectStoreSyncStateError(`Corrupt ${label}: invalid trustedHeads`, "corrupt_state");
  }
  if (record.ledger !== undefined && !Array.isArray(record.ledger)) {
    throw new ObjectStoreSyncStateError(`Corrupt ${label}: invalid ledger`, "corrupt_state");
  }
  if (record.conflicts !== undefined && !Array.isArray(record.conflicts)) {
    throw new ObjectStoreSyncStateError(`Corrupt ${label}: invalid conflicts`, "corrupt_state");
  }
  return {
    ...base,
    selfNextSeq,
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

/** @param {object[]} a @param {object[]} b */
function unionLedger(a, b) {
  const seen = new Set();
  /** @type {object[]} */
  const out = [];
  for (const row of [...a, ...b]) {
    const key = `${row.op}:${row.context_id}:${row.client_id}:${row.sourceDevH}:${row.sourceSeq}:${row.clientNodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** @param {object[]} a @param {object[]} b */
function unionConflicts(a, b) {
  const byId = new Map();
  for (const row of [...a, ...b]) {
    const id = String(row.id ?? row.client_id ?? "");
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, row);
  }
  return [...byId.values()];
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} persisted
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} incoming
 */
export function mergeObjectStoreLocalSyncState(persisted, incoming) {
  for (const [devH, head] of Object.entries(incoming.trustedHeads ?? {})) {
    if (!head) continue;
    const prev = persisted.trustedHeads[devH];
    if (!prev) {
      persisted.trustedHeads[devH] = { seq: head.seq, digest: head.digest };
      continue;
    }
    if (head.seq > prev.seq) {
      persisted.trustedHeads[devH] = { seq: head.seq, digest: head.digest };
    } else if (head.seq === prev.seq) {
      checkTrustedHeadAdvance(prev, head);
    }
  }
  persisted.selfNextSeq = Math.max(persisted.selfNextSeq, incoming.selfNextSeq);
  const mergedCursor = normalizeVectorSyncCursor(persisted.vectorCursor);
  const incomingCursor = normalizeVectorSyncCursor(incoming.vectorCursor);
  for (const [devH, seq] of Object.entries(incomingCursor.v ?? {})) {
    advanceVectorCursorDevH(mergedCursor, devH, Number(seq));
  }
  persisted.vectorCursor = mergedCursor;
  persisted.ledger = unionLedger(persisted.ledger ?? [], incoming.ledger ?? []);
  persisted.conflicts = unionConflicts(persisted.conflicts ?? [], incoming.conflicts ?? []);
  persisted.changeOrdinal = Math.max(persisted.changeOrdinal, incoming.changeOrdinal);
  const prevHlc = persisted.localHlc ?? { wall_ms: 0, counter: 0 };
  const nextHlc = incoming.localHlc ?? prevHlc;
  if (nextHlc.wall_ms > prevHlc.wall_ms || (nextHlc.wall_ms === prevHlc.wall_ms && nextHlc.counter > prevHlc.counter)) {
    persisted.localHlc = { ...nextHlc };
  }
  if (incoming.logListCursor) persisted.logListCursor = incoming.logListCursor;
}

/**
 * Atomic JSON file backend (~/.infinitecontext/sync-cli-state.json objectStoreSync field).
 * @param {string} cliStateFilePath
 */
export function createCliFileObjectStoreLocalState(cliStateFilePath) {
  const lockPath = `${cliStateFilePath}.lock`;
  return {
    load() {
      if (!fs.existsSync(cliStateFilePath)) {
        return createEmptyObjectStoreLocalSyncState();
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(cliStateFilePath, "utf8"));
      } catch {
        throw new ObjectStoreSyncStateError("Corrupt sync-cli-state.json", "corrupt_state");
      }
      if (!parsed.objectStoreSync) {
        return createEmptyObjectStoreLocalSyncState();
      }
      return hydrateObjectStoreLocalSyncState(parsed.objectStoreSync, "sync-cli-state.json");
    },
    save(incoming) {
      const dir = path.dirname(cliStateFilePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const lockFd = acquireFileLock(lockPath);
      try {
        let envelope = { cursor: 0 };
        if (fs.existsSync(cliStateFilePath)) {
          try {
            envelope = JSON.parse(fs.readFileSync(cliStateFilePath, "utf8"));
          } catch {
            throw new ObjectStoreSyncStateError("Corrupt sync-cli-state.json", "corrupt_state");
          }
        }
        const persisted = envelope.objectStoreSync
          ? hydrateObjectStoreLocalSyncState(envelope.objectStoreSync, "sync-cli-state.json")
          : createEmptyObjectStoreLocalSyncState();
        mergeObjectStoreLocalSyncState(persisted, incoming);
        envelope.objectStoreSync = serializeObjectStoreLocalSyncState(persisted);
        const tmp = uniqueTmpPath(cliStateFilePath);
        fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
        const fd = fs.openSync(tmp, "r+");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(tmp, cliStateFilePath);
      } finally {
        releaseFileLock(lockFd, lockPath);
      }
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
        return hydrateObjectStoreLocalSyncState(JSON.parse(String(row.state_json)), "daemon.db object_store_sync_state");
      } catch (err) {
        if (err instanceof ObjectStoreSyncStateError) throw err;
        throw new ObjectStoreSyncStateError("Corrupt daemon object store sync state", "corrupt_state");
      }
    },
    save(incoming) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = getRow.get();
        const persisted = row?.state_json
          ? hydrateObjectStoreLocalSyncState(JSON.parse(String(row.state_json)), "daemon.db object_store_sync_state")
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
