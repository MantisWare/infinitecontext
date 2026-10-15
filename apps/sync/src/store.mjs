import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  normalizeVectorSyncCursor,
  parseStoredSyncCursor,
  serializeVectorSyncCursor,
} from "#sync-cursor";

import { expandHome } from "./utils.mjs";
import { isObjectStoreSyncChange } from "./object-store-sync-change.mjs";
import { loadSyncReplicaDaemonModule } from "./load-sync-replica-daemon.mjs";

const DEFAULT_DB_PATH = "~/.infinitecontext/daemon.db";

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseNumber(value, fallback = 0) {
  const num = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) ? num : fallback;
}

function parseBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveDbPath(env = process.env) {
  return expandHome(env.INFINITECONTEXT_DB_FILE ?? DEFAULT_DB_PATH);
}

export function createStore({ dbPath = resolveDbPath(process.env) } = {}) {
  const resolvedPath = path.resolve(dbPath);
  ensureParentDir(resolvedPath);

  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_events (
      event_hash TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS file_offsets (
      file_key TEXT PRIMARY KEY,
      offset_value INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS context_cache (
      cache_key TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sync_context_meta (
      context_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sync_message_nodes (
      client_node_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sync_replica_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      replica_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);

  const stmt = {
    markSeen: db.prepare(`
      INSERT OR IGNORE INTO seen_events (event_hash, expires_at)
      VALUES (?, ?)
    `),
    deleteSeenIfExpired: db.prepare(`
      DELETE FROM seen_events
      WHERE event_hash = ? AND expires_at <= unixepoch()
    `),
    cleanupSeen: db.prepare(`
      DELETE FROM seen_events
      WHERE expires_at <= unixepoch()
    `),
    getSeen: db.prepare(`
      SELECT event_hash
      FROM seen_events
      WHERE event_hash = ? AND expires_at > unixepoch()
      LIMIT 1
    `),
    getOffset: db.prepare(`
      SELECT offset_value
      FROM file_offsets
      WHERE file_key = ?
      LIMIT 1
    `),
    setOffset: db.prepare(`
      INSERT INTO file_offsets (file_key, offset_value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(file_key) DO UPDATE SET
        offset_value = excluded.offset_value,
        updated_at = unixepoch()
    `),
    getContextCache: db.prepare(`
      SELECT context_id
      FROM context_cache
      WHERE cache_key = ?
      LIMIT 1
    `),
    setContextCache: db.prepare(`
      INSERT INTO context_cache (cache_key, context_id, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(cache_key) DO UPDATE SET
        context_id = excluded.context_id,
        updated_at = unixepoch()
    `),
    upsertSyncContextMeta: db.prepare(`
      INSERT INTO sync_context_meta (context_id, metadata_json, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(context_id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        updated_at = unixepoch()
    `),
    upsertSyncMessage: db.prepare(`
      INSERT INTO sync_message_nodes (client_node_id, context_id, payload_json, sequence, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(client_node_id) DO UPDATE SET
        context_id = excluded.context_id,
        payload_json = excluded.payload_json,
        sequence = excluded.sequence,
        updated_at = unixepoch()
    `),
    deleteSyncMessage: db.prepare(`
      DELETE FROM sync_message_nodes WHERE client_node_id = ?
    `),
    getSyncReplica: db.prepare(`
      SELECT replica_json FROM sync_replica_state WHERE id = 1 LIMIT 1
    `),
    upsertSyncReplica: db.prepare(`
      INSERT INTO sync_replica_state (id, replica_json, updated_at)
      VALUES (1, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        replica_json = excluded.replica_json,
        updated_at = unixepoch()
    `),
  };

  // manual transaction wrapper (node:sqlite has no .transaction() helper)
  function markEventSeenTxn(eventHash, ttlSeconds) {
    db.exec("BEGIN");
    try {
      stmt.deleteSeenIfExpired.run(eventHash);
      const expiresAt = Math.floor(Date.now() / 1000) + Math.max(parseNumber(ttlSeconds, 60), 1);
      const result = stmt.markSeen.run(eventHash, expiresAt);
      db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function readJsonState(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function migrateDaemonPullCursor() {
    const current = stmt.getOffset.get("sync:pull_cursor");
    if (current?.offset_value) {
      const parsed = parseStoredSyncCursor(current.offset_value);
      if (parsed.kind === "vector" && Object.keys(parsed.v).length > 0) {
        return;
      }
      if (typeof current.offset_value === "string" && current.offset_value.trim().startsWith("{")) {
        return;
      }
      const numeric = parseNumber(current.offset_value, 0);
      if (numeric > 0) return;
    }
    const icDir = path.dirname(resolvedPath);
    const legacy = readJsonState(path.join(icDir, "sync-state.json"));
    const legacyCursor = legacy && typeof legacy === "object" ? parseNumber(legacy.cursor, 0) : 0;
    if (legacyCursor > 0) {
      stmt.setOffset.run("sync:pull_cursor", String(legacyCursor));
      return;
    }
  }

  migrateDaemonPullCursor();

  /** @type {ReturnType<import("../../js-sdk/lib/sync-replica-daemon-store.mjs").createDaemonSyncReplicaPersistence> | null} */
  let replicaPersistence = null;
  /** @type {Promise<void> | null} */
  let replicaPersistenceInit = null;

  function ensureReplicaPersistenceInit() {
    if (replicaPersistence) return Promise.resolve();
    if (!replicaPersistenceInit) {
      replicaPersistenceInit = loadSyncReplicaDaemonModule().then((mod) => {
        replicaPersistence = mod.createDaemonSyncReplicaPersistence(db, stmt);
      });
    }
    return replicaPersistenceInit;
  }

  function applyHostedSyncChange(change) {
    if (!change || typeof change !== "object") return;
    const op = String(change.op ?? "");
    const contextId = change.context_id ? String(change.context_id) : "";
    const payload = change.payload && typeof change.payload === "object" ? change.payload : {};
    const sequence = parseNumber(change.sequence, 0);

    if (op === "context_create" || op === "context_fork" || op === "context_metadata") {
      const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : payload;
      const id = String(payload.context_id ?? contextId ?? "");
      if (id) stmt.upsertSyncContextMeta.run(id, JSON.stringify(meta));
      return;
    }

    if (op === "context_delete") {
      const id = String(payload.context_id ?? contextId ?? "");
      if (id) stmt.upsertSyncContextMeta.run(id, JSON.stringify({ deleted: true }));
      return;
    }

    if (op === "contexts_delete_many") {
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const row of results) {
        if (row?.deleted !== true) continue;
        const id = String(row?.id ?? row?.context_id ?? "");
        if (id) stmt.upsertSyncContextMeta.run(id, JSON.stringify({ deleted: true }));
      }
      return;
    }

    if (op === "message_delete") {
      const deletedIds = Array.isArray(payload.deleted_client_ids) ? payload.deleted_client_ids : [];
      for (const id of deletedIds) {
        if (id) stmt.deleteSyncMessage.run(String(id));
      }
      return;
    }

    if (op === "message_append" || op === "message_update") {
      const rows = Array.isArray(payload.data) ? payload.data : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const clientNodeId = row.metadata?.ic_client_node_id ?? row.id;
        if (!clientNodeId) continue;
        stmt.upsertSyncMessage.run(
          String(clientNodeId),
          String(payload.context_id ?? contextId),
          JSON.stringify(row),
          sequence,
        );
      }
      return;
    }

    if (op === "prune_plaintext_versions") {
      const id = String(payload.context_id ?? contextId ?? "");
      if (id) {
        stmt.upsertSyncContextMeta.run(id, JSON.stringify({ pruned_plaintext: true, ...(payload ?? {}) }));
      }
    }
  }

  return {
    dbPath: resolvedPath,
    async initObjectStoreReplica() {
      await ensureReplicaPersistenceInit();
    },
    markEventSeen(eventHash, ttlSeconds) {
      return markEventSeenTxn(String(eventHash ?? ""), ttlSeconds);
    },
    isEventSeen(eventHash) {
      return Boolean(stmt.getSeen.get(String(eventHash ?? "")));
    },
    cleanupExpired() {
      stmt.cleanupSeen.run();
    },
    getOffset(fileKey) {
      const row = stmt.getOffset.get(String(fileKey ?? ""));
      return row ? parseNumber(row.offset_value, 0) : 0;
    },
    setOffset(fileKey, value) {
      stmt.setOffset.run(String(fileKey ?? ""), parseNumber(value, 0));
    },
    getSyncPullCursor() {
      const row = stmt.getOffset.get("sync:pull_cursor");
      if (!row) return 0;
      const text = String(row.offset_value ?? "");
      if (text.trim().startsWith("{")) {
        return parseStoredSyncCursor(text);
      }
      return parseNumber(text, 0);
    },
    setSyncPullCursor(value) {
      if (value && typeof value === "object" && value.kind === "vector") {
        stmt.setOffset.run("sync:pull_cursor", serializeVectorSyncCursor(normalizeVectorSyncCursor(value)));
        return;
      }
      stmt.setOffset.run("sync:pull_cursor", String(parseNumber(value, 0)));
    },
    getContextCache(cacheKey) {
      const row = stmt.getContextCache.get(String(cacheKey ?? ""));
      return row ? String(row.context_id ?? "") : "";
    },
    setContextCache(cacheKey, contextId) {
      stmt.setContextCache.run(String(cacheKey ?? ""), String(contextId ?? ""));
    },
    loadSyncReplica() {
      if (!replicaPersistence) {
        throw new Error("Object store replica is not initialized — call initObjectStoreReplica() first");
      }
      return replicaPersistence.loadSyncReplica();
    },
    flushSyncReplica(replica) {
      if (!replicaPersistence) {
        throw new Error("Object store replica is not initialized — call initObjectStoreReplica() first");
      }
      replicaPersistence.flushSyncReplica(replica);
    },
    clearReplicaCache() {
      replicaPersistence?.clearReplicaCache();
    },
    applySyncChange(change) {
      if (!change || typeof change !== "object") return;
      if (isObjectStoreSyncChange(change)) {
        if (!replicaPersistence) {
          throw new Error("Object store replica is not initialized — call initObjectStoreReplica() first");
        }
        replicaPersistence.applyObjectStoreSyncChange(change, (hostedChange) => {
          applyHostedSyncChange(hostedChange);
        });
        return;
      }
      applyHostedSyncChange(change);
    },
    close() {
      replicaPersistence = null;
      replicaPersistenceInit = null;
      db.close();
    },
  };
}
