import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateClientNodeId } from "./ic-crypto.mjs";
import { pullSyncChanges, pushSyncMutations } from "./sync-api.mjs";

const SYNC_STATE_FILE = path.join(os.homedir(), ".infinitecontext", "sync-state.json");

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

export function queueSyncMutation(mutation) {
  const state = readSyncState();
  const outbox = Array.isArray(state.outbox) ? state.outbox : [];
  outbox.push(mutation);
  writeSyncState({ ...state, outbox });
}

export async function flushSyncOutbox({ baseUrl, log } = {}) {
  const state = readSyncState();
  const outbox = Array.isArray(state.outbox) ? state.outbox : [];
  if (outbox.length === 0) return { pushed: 0 };

  const result = await pushSyncMutations(outbox, { baseUrl });
  writeSyncState({ ...state, outbox: [], cursor: Math.max(state.cursor ?? 0, result.head_sequence ?? 0) });
  if (log && result.conflicts?.length) {
    log("warn", "Sync push recorded conflicts", { count: result.conflicts.length });
  }
  return { pushed: result.applied?.length ?? 0, result };
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
