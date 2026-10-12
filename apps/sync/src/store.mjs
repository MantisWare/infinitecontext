import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expandHome } from "./utils.mjs";

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

  return {
    dbPath: resolvedPath,
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
    getContextCache(cacheKey) {
      const row = stmt.getContextCache.get(String(cacheKey ?? ""));
      return row ? String(row.context_id ?? "") : "";
    },
    setContextCache(cacheKey, contextId) {
      stmt.setContextCache.run(String(cacheKey ?? ""), String(contextId ?? ""));
    },
    applySyncChange(change) {
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
          const id = String(row?.id ?? row?.context_id ?? "");
          if (id) stmt.upsertSyncContextMeta.run(id, JSON.stringify({ deleted: true }));
        }
        return;
      }

      if (op === "message_append" || op === "message_update" || op === "message_delete") {
        const rows = Array.isArray(payload.data) ? payload.data : [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const clientNodeId = row.metadata?.ic_client_node_id ?? row.id;
          if (!clientNodeId) continue;
          stmt.upsertSyncMessage.run(String(clientNodeId), String(payload.context_id ?? contextId), JSON.stringify(row), sequence);
        }
        return;
      }

      if (op === "prune_plaintext_versions") {
        const id = String(payload.context_id ?? contextId ?? "");
        if (id) {
          stmt.upsertSyncContextMeta.run(id, JSON.stringify({ pruned_plaintext: true, ...(payload ?? {}) }));
        }
      }
    },
    close() {
      db.close();
    },
  };
}
