import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateClientNodeId } from "./ic-crypto.mjs";
import { snapshotVectorCursor } from "./object-store-delete-stale.mjs";
import {
  createCliFileObjectStoreLocalState,
  defaultObjectStoreSyncStatePath,
} from "./object-store-local-state-persist.mjs";
import { applySyncChangeToReplica, createEmptySyncReplica } from "./sync-replica-apply.mjs";
import { ObjectStoreSyncStateError } from "./object-store-state-errors.mjs";
import { isObjectStoreSyncChange } from "./sync-replica-daemon-store.mjs";
import {
  hydrateSyncReplica,
  sanitizeSyncReplicaForPersist,
  wrapReplicaJsonParseError,
} from "./sync-replica-state.mjs";
import { normalizeVectorSyncCursor, vectorCursorHeadSum } from "./sync-cursor.mjs";

export { applySyncChangeToReplica, createEmptySyncReplica } from "./sync-replica-apply.mjs";
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

function readSyncReplicaFile() {
  if (!fs.existsSync(SYNC_REPLICA_FILE)) {
    return createEmptySyncReplica();
  }
  try {
    const text = fs.readFileSync(SYNC_REPLICA_FILE, "utf8");
    return hydrateSyncReplica(JSON.parse(text));
  } catch (err) {
    wrapReplicaJsonParseError(err);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
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
  return readSyncReplicaFile();
}

/** Vector cursor from dedicated object-store sync state (not sync-cli-state.json). */
export function readObjectStoreSyncVectorCursor() {
  const backend = createCliFileObjectStoreLocalState(defaultObjectStoreSyncStatePath());
  return normalizeVectorSyncCursor(backend.load().vectorCursor);
}

/** Persist vector pull cursor for CLI object-store sync (matches readObjectStoreSyncVectorCursor). */
export async function writeObjectStoreSyncVectorCursor(cursor) {
  const backend = createCliFileObjectStoreLocalState(defaultObjectStoreSyncStatePath());
  const state = backend.load();
  state.vectorCursor = normalizeVectorSyncCursor(cursor);
  await backend.save(state);
}

/** Snapshot for message_delete planning (carried on outbox mutations). */
export function snapshotObjectStoreBaseVector() {
  return snapshotVectorCursor(readObjectStoreSyncVectorCursor());
}

function writeReplica(replica) {
  writeJsonFile(SYNC_REPLICA_FILE, sanitizeSyncReplicaForPersist(replica));
}

/** Lightweight on-disk replica for `infinitecontext sync pull` (no daemon.db). */
export function createCliSyncStore() {
  return {
    loadSyncReplica() {
      return readReplica();
    },
    flushSyncReplica(replica) {
      writeReplica(replica);
    },
    applySyncChange(change) {
      const replica = readReplica();
      applySyncChangeToReplica(replica, change, () => {});
      writeReplica(replica);
    },
    flushReplica(replica) {
      writeReplica(replica);
    },
  };
}

function transportUsesVectorPullCursor(syncTransport) {
  return Boolean(syncTransport?.usesVectorPullCursor);
}


export async function pullAndApplySync({ baseUrl, store, log, getCursor, setCursor, transport } = {}) {
  const syncTransport = transport ?? getDefaultSyncTransport();
  const vectorPull = transportUsesVectorPullCursor(syncTransport);
  const readCursor =
    getCursor ??
    (() => (vectorPull ? readObjectStoreSyncVectorCursor() : getSyncCursor()));
  const writeCursor =
    setCursor ??
    (async (value) => {
      if (vectorPull) {
        await writeObjectStoreSyncVectorCursor(value);
      }
      writeCliSyncState({ cursor: value });
    });

  let since = readCursor() ?? 0;
  if (!vectorPull && typeof since !== "object") {
    since = Number(since ?? 0);
  }
  let total = 0;
  let hasMore = true;
  let lastPage = null;

  /** @type {ReturnType<typeof createEmptySyncReplica> | null} */
  let daemonReplica = null;
  const objectStoreReplicaPull = Boolean(store?.objectStoreReplicaPullEnabled);
  if (objectStoreReplicaPull && store?.loadSyncReplica && store?.flushSyncReplica) {
    try {
      daemonReplica = store.loadSyncReplica();
    } catch (err) {
      if (err instanceof ObjectStoreSyncStateError && err.code === "corrupt_state") {
        throw err;
      }
      daemonReplica = null;
    }
  }
  const daemonReplicaMode = daemonReplica !== null;
  const cliReplicaMode = Boolean(store?.flushReplica || (vectorPull && store?.flushSyncReplica));
  /** @type {ReturnType<typeof createEmptySyncReplica> | null} */
  let cliReplica =
    cliReplicaMode && !daemonReplicaMode
      ? store?.loadSyncReplica?.() ?? readReplica()
      : null;
  const persistReplica = () => {
    if (daemonReplica && daemonReplicaMode) store.flushSyncReplica(daemonReplica);
    else if (cliReplica && cliReplicaMode) {
      if (store?.flushSyncReplica) store.flushSyncReplica(cliReplica);
      else store.flushReplica(cliReplica);
    }
  };

  const applyBootstrapReplica = (bootstrapPlain) => {
    if (daemonReplicaMode && store?.flushSyncReplica) {
      daemonReplica = hydrateSyncReplica(bootstrapPlain);
      store.flushSyncReplica(daemonReplica);
      return;
    }
    if (cliReplicaMode) {
      cliReplica = hydrateSyncReplica(bootstrapPlain);
      persistReplica();
    }
  };

  while (hasMore) {
    /** @type {{ since?: unknown, limit: number, baseUrl?: string }} */
    const pullOptions = { limit: 500, baseUrl };
    if (vectorPull) {
      if (since && typeof since === "object" && since.kind === "vector") {
        pullOptions.since = since;
      }
    } else {
      pullOptions.since = since;
    }
    lastPage = await syncTransport.pullSyncChanges(pullOptions);
    if (lastPage?.bootstrap_replica) {
      applyBootstrapReplica(lastPage.bootstrap_replica);
    }
    for (const change of lastPage.changes ?? []) {
      if (store?.applySyncChange || daemonReplica || cliReplica) {
        if (daemonReplica && objectStoreReplicaPull && isObjectStoreSyncChange(change)) {
          applySyncChangeToReplica(daemonReplica, change, () => {});
        } else if (cliReplica) {
          applySyncChangeToReplica(cliReplica, change, () => {});
        } else if (store?.applySyncChange) {
          store.applySyncChange(change);
        }
      }
      if (!vectorPull && typeof since === "number") {
        since = change.sequence;
      }
      total += 1;
    }
    persistReplica();
    if (typeof syncTransport.confirmPullDelivery === "function") {
      await syncTransport.confirmPullDelivery();
    }
    if (lastPage?.next_since !== undefined && lastPage?.next_since !== null) {
      since = lastPage.next_since;
    }
    await writeCursor(since);
    hasMore = Boolean(lastPage.has_more);
    if (!hasMore) break;
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

export function mutationForMessageUpdate(contextId, messages, { base_vector: baseVector } = {}) {
  const base_vector = baseVector
    ? snapshotVectorCursor(normalizeVectorSyncCursor(baseVector))
    : snapshotObjectStoreBaseVector();
  return {
    client_id: generateClientNodeId(),
    op: "message_update",
    context_id: contextId,
    base_vector,
    payload: { messages, base_vector },
  };
}

export function mutationForMessageDelete(contextId, ids, { base_sequence: baseSequence, base_vector: baseVector } = {}) {
  const idList = Array.isArray(ids) ? ids : [ids];
  const base_vector = baseVector
    ? snapshotVectorCursor(normalizeVectorSyncCursor(baseVector))
    : snapshotObjectStoreBaseVector();
  const resolvedBase = resolveDeleteBaseSequence({ explicitBaseSequence: baseSequence, localCursor: base_vector });
  let base_sequence;
  if (typeof resolvedBase === "number" && Number.isFinite(resolvedBase)) {
    base_sequence = resolvedBase;
  } else if (resolvedBase && typeof resolvedBase === "object" && resolvedBase.kind === "vector") {
    base_sequence = vectorCursorHeadSum(resolvedBase);
  } else {
    base_sequence = vectorCursorHeadSum(base_vector);
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
    base_vector,
    payload: { ids: idList, base_vector },
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
