import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateClientNodeId } from "./ic-crypto.mjs";
import { pullSyncChanges, pushSyncMutations } from "./sync-api.mjs";

const SYNC_STATE_FILE = path.join(os.homedir(), ".infinitecontext", "sync-state.json");
const SYNC_REPLICA_FILE = path.join(os.homedir(), ".infinitecontext", "sync-replica.json");

function readSyncState() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf8"));
  } catch {
    return { cursor: 0, outbox: [] };
  }
}

function writeSyncState(state) {
  const dir = path.dirname(SYNC_STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SYNC_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, SYNC_STATE_FILE);
}

export function getSyncCursor() {
  return Number(readSyncState().cursor ?? 0);
}

export function readLocalSyncState() {
  const state = readSyncState();
  return {
    cursor: Number(state.cursor ?? 0),
    outbox: Array.isArray(state.outbox) ? state.outbox : [],
    parked_failures: Array.isArray(state.parked_failures) ? state.parked_failures : [],
  };
}

export function queueSyncMutation(mutation) {
  const state = readSyncState();
  const outbox = Array.isArray(state.outbox) ? state.outbox : [];
  outbox.push(mutation);
  writeSyncState({ ...state, outbox });
}

function settledClientIds(result) {
  const settled = new Set(result.applied ?? []);
  for (const id of result.duplicate ?? []) settled.add(id);
  for (const row of result.conflicts ?? []) {
    if (row.client_id) settled.add(row.client_id);
  }
  for (const row of result.failed ?? []) {
    if (!row.retryable && row.client_id) settled.add(row.client_id);
  }
  return settled;
}

export async function flushSyncOutbox({ baseUrl, log } = {}) {
  const state = readSyncState();
  const outbox = Array.isArray(state.outbox) ? state.outbox : [];
  if (outbox.length === 0) return { pushed: 0 };

  const result = await pushSyncMutations(outbox, { baseUrl });
  const settled = settledClientIds(result);
  const remaining = outbox.filter((m) => !settled.has(m.client_id));
  const parkedExisting = Array.isArray(state.parked_failures) ? state.parked_failures : [];
  const parkedById = new Map(parkedExisting.map((row) => [row.client_id, row]));
  for (const row of result.failed ?? []) {
    if (row?.retryable || !row?.client_id) continue;
    parkedById.set(row.client_id, row);
  }
  const parked_failures = [...parkedById.values()];
  writeSyncState({ ...state, outbox: remaining, parked_failures });
  if (log && result.conflicts?.length) {
    log("warn", "Sync push recorded conflicts", { count: result.conflicts.length });
  }
  if (log && result.failed?.length) {
    const retryable = result.failed.filter((row) => row.retryable);
    if (retryable.length) {
      log("warn", "Sync push left retryable mutations in outbox", { count: retryable.length });
    }
    const dropped = result.failed.filter((row) => !row.retryable);
    if (dropped.length) {
      log("warn", "Sync push parked non-retryable failures", { count: dropped.length });
    }
  }
  return { pushed: result.applied?.length ?? 0, result, remaining: remaining.length, parked_failures };
}

function readReplica() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_REPLICA_FILE, "utf8"));
  } catch {
    return { contexts: {}, messages: {} };
  }
}

function writeReplica(replica) {
  const dir = path.dirname(SYNC_REPLICA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SYNC_REPLICA_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(replica, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, SYNC_REPLICA_FILE);
}

/** Lightweight on-disk replica for `infinitecontext sync pull` (no daemon.db). */
export function createCliSyncStore() {
  return {
    applySyncChange(change) {
      applySyncChangeToReplica(readReplica(), change, writeReplica);
    },
  };
}

export function applySyncChangeToReplica(replica, change, persist) {
  if (!change || typeof change !== "object") return;
  const op = String(change.op ?? "");
  const contextId = change.context_id ? String(change.context_id) : "";
  const payload = change.payload && typeof change.payload === "object" ? change.payload : {};
  const sequence = Number(change.sequence ?? 0);

  if (op === "context_create" || op === "context_fork" || op === "context_metadata") {
    const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : payload;
    const id = String(payload.context_id ?? contextId ?? "");
    if (id) {
      replica.contexts[id] = { metadata: meta, sequence, deleted: false };
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
      const id = String(row?.id ?? row?.context_id ?? "");
      if (id) replica.contexts[id] = { ...(replica.contexts[id] ?? {}), deleted: true, sequence };
    }
    persist(replica);
    return;
  }

  if (op === "message_append") {
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const clientNodeId = row.metadata?.ic_client_node_id ?? row.id;
      if (!clientNodeId) continue;
      replica.messages[String(clientNodeId)] = {
        context_id: String(payload.context_id ?? contextId),
        payload: row,
        sequence,
      };
    }
    persist(replica);
    return;
  }

  if (op === "message_delete") {
    const deletedIds = Array.isArray(payload.deleted_client_ids) ? payload.deleted_client_ids : [];
    for (const id of deletedIds) {
      if (id) delete replica.messages[String(id)];
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const clientNodeId = row.metadata?.ic_client_node_id ?? row.id;
      if (!clientNodeId) continue;
      replica.messages[String(clientNodeId)] = {
        context_id: String(payload.context_id ?? contextId),
        payload: row,
        sequence,
        op,
      };
    }
    persist(replica);
    return;
  }

  if (op === "message_update") {
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const clientNodeId = row.metadata?.ic_client_node_id ?? row.id;
      if (!clientNodeId) continue;
      replica.messages[String(clientNodeId)] = {
        context_id: String(payload.context_id ?? contextId),
        payload: row,
        sequence,
        op,
      };
    }
    persist(replica);
  }
}

export async function pullAndApplySync({ baseUrl, store, log } = {}) {
  const state = readSyncState();
  let since = Number(state.cursor ?? 0);
  let total = 0;
  let hasMore = true;

  let lastPage = null;
  while (hasMore) {
    lastPage = await pullSyncChanges({ since, limit: 500, baseUrl });
    for (const change of lastPage.changes ?? []) {
      if (store?.applySyncChange) {
        store.applySyncChange(change);
      }
      since = change.sequence;
      total += 1;
    }
    hasMore = Boolean(lastPage.has_more);
    if ((lastPage.changes ?? []).length === 0) break;
  }

  writeSyncState({ ...state, cursor: since });
  if (log && total > 0) log("info", "Applied sync pull", { changes: total, cursor: since });
  const conflictCount = pageConflicts(lastPage);
  if (log && conflictCount > 0) {
    log("warn", "Sync conflicts pending", { count: conflictCount });
  }
  return { applied: total, cursor: since, conflicts: lastPage?.conflicts ?? [] };
}

function pageConflicts(page) {
  return Array.isArray(page?.conflicts) ? page.conflicts.length : 0;
}

export function mutationForContextCreate(metadata) {
  return {
    client_id: generateClientNodeId(),
    op: "context_create",
    payload: { metadata },
  };
}

export function mutationForMessageAppend(contextId, messages) {
  return {
    client_id: generateClientNodeId(),
    op: "message_append",
    context_id: contextId,
    payload: { messages },
  };
}

export function mutationForContextMetadata(contextId, metadata, updatedAt = new Date().toISOString()) {
  return {
    client_id: generateClientNodeId(),
    op: "context_metadata",
    context_id: contextId,
    updated_at: updatedAt,
    payload: { metadata },
  };
}
