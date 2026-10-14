import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateClientNodeId } from "./ic-crypto.mjs";
import { normalizeVectorSyncCursor, vectorCursorHeadSum } from "./sync-cursor.mjs";
import { getDefaultSyncTransport } from "./sync-transport.mjs";
import "./hosted-sync-transport.mjs";

const SYNC_DIR = path.join(os.homedir(), ".infinitecontext");
const SYNC_STATE_FILE = path.join(SYNC_DIR, "sync-state.json");
const SYNC_CLI_STATE_FILE = path.join(SYNC_DIR, "sync-cli-state.json");
const SYNC_REPLICA_FILE = path.join(SYNC_DIR, "sync-replica.json");

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function migrateLegacySyncState() {
  const legacy = readJsonFile(SYNC_STATE_FILE, null);
  if (!legacy || typeof legacy !== "object") return;
  const cli = readJsonFile(SYNC_CLI_STATE_FILE, { cursor: 0 });
  if (legacy.cursor !== undefined && cli.cursor === 0) {
    cli.cursor = Number(legacy.cursor ?? 0);
    writeJsonFile(SYNC_CLI_STATE_FILE, cli);
  }
  const { cursor: _drop, ...shared } = legacy;
  writeJsonFile(SYNC_STATE_FILE, {
    outbox: Array.isArray(shared.outbox) ? shared.outbox : [],
    parked_failures: Array.isArray(shared.parked_failures) ? shared.parked_failures : [],
  });
}

migrateLegacySyncState();

function readSyncState() {
  const state = readJsonFile(SYNC_STATE_FILE, { outbox: [], parked_failures: [] });
  return {
    outbox: Array.isArray(state.outbox) ? state.outbox : [],
    parked_failures: Array.isArray(state.parked_failures) ? state.parked_failures : [],
  };
}

function writeSyncState(state) {
  writeJsonFile(SYNC_STATE_FILE, {
    outbox: Array.isArray(state.outbox) ? state.outbox : [],
    parked_failures: Array.isArray(state.parked_failures) ? state.parked_failures : [],
  });
}

function readCliSyncState() {
  const state = readJsonFile(SYNC_CLI_STATE_FILE, { cursor: 0 });
  const raw = state.cursor;
  if (raw && typeof raw === "object" && raw.kind === "vector") {
    return { cursor: normalizeVectorSyncCursor(raw) };
  }
  return { cursor: Number(raw ?? 0) };
}

function writeCliSyncState(state) {
  const cursor = state.cursor;
  if (cursor && typeof cursor === "object" && cursor.kind === "vector") {
    writeJsonFile(SYNC_CLI_STATE_FILE, { cursor: normalizeVectorSyncCursor(cursor) });
    return;
  }
  writeJsonFile(SYNC_CLI_STATE_FILE, { cursor: Number(cursor ?? 0) });
}

export function getSyncCursor() {
  const cursor = readCliSyncState().cursor;
  if (cursor && typeof cursor === "object") {
    return cursor;
  }
  return Number(cursor ?? 0);
}

export function readLocalSyncState() {
  const shared = readSyncState();
  const cli = readCliSyncState();
  return {
    cursor: cli.cursor,
    outbox: shared.outbox,
    parked_failures: shared.parked_failures,
  };
}

export function listParkedFailures() {
  return readSyncState().parked_failures;
}

export function dropParkedFailure(clientId) {
  const state = readSyncState();
  const id = String(clientId ?? "");
  const parked_failures = state.parked_failures.filter((row) => row?.client_id !== id);
  if (parked_failures.length === state.parked_failures.length) return false;
  writeSyncState({ ...state, parked_failures });
  return true;
}

export function retryParkedFailure(clientId) {
  const state = readSyncState();
  const id = String(clientId ?? "");
  const row = state.parked_failures.find((entry) => entry?.client_id === id);
  if (!row?.mutation) return false;
  const parked_failures = state.parked_failures.filter((entry) => entry?.client_id !== id);
  const outbox = [...state.outbox, row.mutation];
  writeSyncState({ ...state, outbox, parked_failures });
  return true;
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

export async function flushSyncOutbox({ baseUrl, log, transport } = {}) {
  const state = readSyncState();
  const outbox = Array.isArray(state.outbox) ? state.outbox : [];
  if (outbox.length === 0) return { pushed: 0 };

  const syncTransport = transport ?? getDefaultSyncTransport();
  const result = await syncTransport.pushSyncMutations(outbox, { baseUrl });
  const settled = settledClientIds(result);
  const remaining = outbox.filter((m) => !settled.has(m.client_id));
  const parkedExisting = Array.isArray(state.parked_failures) ? state.parked_failures : [];
  const parkedById = new Map(parkedExisting.map((row) => [row.client_id, row]));
  for (const row of result.failed ?? []) {
    if (row?.retryable || !row?.client_id) continue;
    const mutation = outbox.find((m) => m.client_id === row.client_id);
    parkedById.set(row.client_id, { ...row, mutation });
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
  return readJsonFile(SYNC_REPLICA_FILE, { contexts: {}, messages: {} });
}

function writeReplica(replica) {
  writeJsonFile(SYNC_REPLICA_FILE, replica);
}

/** Lightweight on-disk replica for `infinitecontext sync pull` (no daemon.db). */
export function createCliSyncStore() {
  return {
    applySyncChange(change) {
      applySyncChangeToReplica(readReplica(), change, () => {});
    },
    flushReplica(replica) {
      writeReplica(replica);
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
      if (row?.deleted !== true) continue;
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

export async function pullAndApplySync({ baseUrl, store, log, getCursor, setCursor, transport } = {}) {
  const syncTransport = transport ?? getDefaultSyncTransport();
  const readCursor = getCursor ?? (() => getSyncCursor());
  const writeCursor =
    setCursor ??
    ((value) => {
      writeCliSyncState({ cursor: value });
    });

  let since = readCursor() ?? 0;
  if (typeof since !== "object") {
    since = Number(since ?? 0);
  }
  let total = 0;
  let hasMore = true;
  let lastPage = null;

  const replica = store?.flushReplica ? readReplica() : null;
  const persistReplica = () => {
    if (replica && store?.flushReplica) store.flushReplica(replica);
  };

  while (hasMore) {
    lastPage = await syncTransport.pullSyncChanges({ since, limit: 500, baseUrl });
    for (const change of lastPage.changes ?? []) {
      if (store?.applySyncChange) {
        if (replica) {
          applySyncChangeToReplica(replica, change, () => {});
        } else {
          store.applySyncChange(change);
        }
      }
      if (typeof since === "number") {
        since = change.sequence;
      }
      total += 1;
    }
    if (replica) persistReplica();
    if (lastPage?.next_since !== undefined && lastPage?.next_since !== null) {
      since = lastPage.next_since;
    }
    writeCursor(since);
    hasMore = Boolean(lastPage.has_more);
    if ((lastPage.changes ?? []).length === 0) break;
  }
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

export function resolveDeleteBaseSequence({ explicitBaseSequence, localCursor } = {}) {
  if (typeof explicitBaseSequence === "number" && Number.isFinite(explicitBaseSequence)) {
    return explicitBaseSequence;
  }
  const local = localCursor ?? getSyncCursor();
  if (typeof local === "number" && local > 0) return local;
  if (local && typeof local === "object" && local.kind === "vector") {
    return normalizeVectorSyncCursor(local);
  }
  return null;
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

export function mutationForMessageDelete(contextId, ids, { base_sequence: baseSequence } = {}) {
  const idList = Array.isArray(ids) ? ids : [ids];
  const resolvedBase = resolveDeleteBaseSequence({ explicitBaseSequence: baseSequence });
  let base_sequence;
  if (typeof resolvedBase === "number" && Number.isFinite(resolvedBase)) {
    base_sequence = resolvedBase;
  } else if (resolvedBase && typeof resolvedBase === "object" && resolvedBase.kind === "vector") {
    base_sequence = vectorCursorHeadSum(resolvedBase);
  } else {
    base_sequence = null;
  }
  if (base_sequence === null || !Number.isFinite(base_sequence)) {
    throw new Error(
      "base_sequence is required for message_delete — run sync pull or pass base_sequence from the last GET /contexts read",
    );
  }
  return {
    client_id: generateClientNodeId(),
    op: "message_delete",
    context_id: contextId,
    base_sequence,
    payload: { ids: idList },
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
