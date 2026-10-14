import {
  advanceVectorCursorDevH,
  normalizeVectorSyncCursor,
  vectorCursorHeadSum,
} from "@infinitecontext/sync-cursor";

import {
  assertTrustedHeadAdvance,
  computeHeadSequenceFromTrustedHeads,
  createEmptyObjectStoreLocalSyncState,
  headSequenceForStatus,
  ObjectStoreLogForkError,
  ObjectStoreLogRollbackError,
} from "./object-store-local-sync-state.mjs";
import {
  compareMergeableMutations,
  sortMergeableMutations,
} from "./object-store-merge.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "./storage/encrypt-storage-object.mjs";
import { PreconditionFailedError } from "./storage/errors.mjs";
import {
  canonicalDevH,
  decryptLogSegment,
  deriveDevH,
  encryptLogSegment,
  layoutRootPath,
  layoutSegmentEnvelopeDigest,
  logSegmentRelativePath,
  verifyLogSegmentChain,
} from "./storage/layout.mjs";
import { decryptVaultStorageObjectPlaintext } from "./storage/storage-object-move.mjs";

const LAYOUT_SEGMENT_PLAIN_FIELD = "ic_layout_segment_envelope_v1";

/**
 * @typedef {Object} ObjectStoreSyncContext
 * @property {import('./storage/types.mjs').StorageAdapter} adapter
 * @property {Uint8Array} dek
 * @property {string} layoutPrefix
 * @property {string} selfDevH canonical
 * @property {string} deviceUuid
 * @property {{ load: () => import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState, save: (s: import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState) => void }} localState
 * @property {() => void | Promise<void>} [testHookAfterSegmentWrite]
 * @property {boolean} [testHookSkipLocalSaveAfterSegmentWrite]
 */

/** @param {string} key */
function parseLogSegmentKey(key) {
  const match = /\/log\/([0-9A-HJKMNP-TV-Z]{26})\/(\d{12})\.enc$/i.exec(key);
  if (!match) return null;
  return { devH: canonicalDevH(match[1]), seq: Number(match[2]) };
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} key
 */
async function readLayoutSegmentEnvelope(ctx, key) {
  const row = await ctx.adapter.get(key);
  if (!row?.body) return null;
  const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
  return plain[LAYOUT_SEGMENT_PLAIN_FIELD] ?? null;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} key
 * @param {import('./ic-crypto.mjs').AeadEnvelope} envelope
 */
async function writeLayoutSegmentEnvelope(ctx, key, envelope) {
  const sealed = encryptVaultPlaintextForStoragePut(ctx.dek, key, {
    [LAYOUT_SEGMENT_PLAIN_FIELD]: envelope,
  });
  await ctx.adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), {
    ifNoneMatch: "*",
  });
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH canonical
 */
async function listSegmentKeysForDevH(ctx, devH) {
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/${devH.toLowerCase()}/`;
  const page = await ctx.adapter.list(prefix, { limit: 10_000 });
  return page.objects.map((o) => o.key).filter((k) => parseLogSegmentKey(k)?.devH === devH);
}

/** @param {unknown} raw */
function parseStrictBaseSequence(raw) {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * @param {object[]} ledger
 * @param {number} baseSum
 * @param {string[]} targetClientIds
 */
function hasMessageMutationSinceHeadSum(ledger, baseSum, targetClientIds) {
  const targets = new Set(targetClientIds);
  for (const row of ledger) {
    if (Number(row.headSum) <= baseSum) continue;
    const op = String(row.op ?? "");
    if (op !== "message_update" && op !== "message_delete") continue;
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    for (const key of ["affected_client_ids", "deleted_client_ids"]) {
      const list = payload[key];
      if (!Array.isArray(list)) continue;
      for (const id of list) {
        if (typeof id === "string" && targets.has(id)) return true;
      }
    }
  }
  return false;
}

/** @param {unknown} idsRaw @param {object} ledger @param {string} contextId */
function resolveDeleteTargetClientIds(idsRaw, ledger, contextId) {
  const idList = Array.isArray(idsRaw) ? idsRaw : idsRaw === undefined ? [] : [idsRaw];
  /** @type {string[]} */
  const resolved = [];
  for (const raw of idList) {
    if (typeof raw === "string" && raw.startsWith("icn_")) {
      resolved.push(raw);
      continue;
    }
    if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) {
      const idx = Number(raw);
      const hit = [...ledger].reverse().find(
        (row) =>
          row.context_id === contextId &&
          (row.op === "message_append" || row.op === "message_update") &&
          Number(row.messageIndex) === idx,
      );
      if (hit?.clientNodeId) resolved.push(String(hit.clientNodeId));
    }
  }
  return resolved;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
async function reconcileOwnLogPrefix(ctx, state) {
  const keys = await listSegmentKeysForDevH(ctx, ctx.selfDevH);
  keys.sort((a, b) => (parseLogSegmentKey(a)?.seq ?? 0) - (parseLogSegmentKey(b)?.seq ?? 0));
  /** @type {Set<string>} */
  const clientIds = new Set();
  let maxSeq = -1;
  let lastDigest = "";
  for (const key of keys) {
    const parsed = parseLogSegmentKey(key);
    if (!parsed) continue;
    const envelope = await readLayoutSegmentEnvelope(ctx, key);
    if (!envelope) continue;
    const record = decryptLogSegment(ctx.dek, ctx.selfDevH, parsed.seq, envelope);
    for (const m of record.mutations) {
      if (m?.client_id) clientIds.add(String(m.client_id));
    }
    maxSeq = parsed.seq;
    lastDigest = layoutSegmentEnvelopeDigest(envelope);
  }
  if (maxSeq >= 0) {
    assertTrustedHeadAdvance(state, ctx.selfDevH, { seq: maxSeq, digest: lastDigest });
    state.selfNextSeq = maxSeq + 1;
  }
  return clientIds;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./storage/layout.mjs').LayoutLogSegmentRecord} record
 * @param {number} seq
 */
async function verifyRemoteSegmentChain(ctx, devH, seq) {
  /** @type {{ seq: number, envelope: import('./ic-crypto.mjs').AeadEnvelope }[]} */
  const segments = [];
  for (let i = 0; i <= seq; i += 1) {
    const key = logSegmentRelativePath(ctx.layoutPrefix, devH, i);
    const envelope = await readLayoutSegmentEnvelope(ctx, key);
    if (!envelope) {
      throw new Error(`Missing segment ${key}`);
    }
    segments.push({ seq: i, envelope });
  }
  const head = segments[segments.length - 1];
  verifyLogSegmentChain(ctx.dek, devH, segments, {
    seq: head.seq,
    digest: layoutSegmentEnvelopeDigest(head.envelope),
  });
  return decryptLogSegment(ctx.dek, devH, seq, head.envelope);
}

export async function objectStoreFetchSyncStatus(ctx) {
  const state = ctx.localState.load();
  return { head_sequence: headSequenceForStatus(state) };
}

export async function objectStorePullSyncChanges(ctx, options = {}) {
  const segmentLimit = options.limit ?? 500;
  const state = ctx.localState.load();
  const cursor = normalizeVectorSyncCursor(options.since ?? state.vectorCursor);

  /** @type {{ devH: string, seq: number, key: string, record: import('./storage/layout.mjs').LayoutLogSegmentRecord }[]} */
  const pendingSegments = [];
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/`;
  const listed = await ctx.adapter.list(prefix, { limit: 10_000 });
  for (const row of listed.objects) {
    const parsed = parseLogSegmentKey(row.key);
    if (!parsed) continue;
    const after = cursor.v[parsed.devH] ?? -1;
    if (parsed.seq <= after) continue;
    pendingSegments.push({ ...parsed, key: row.key, record: null });
  }
  pendingSegments.sort((a, b) => a.seq - b.seq);

  /** @type {import('./object-store-merge.mjs').MergeableMutation[]} */
  const mergeItems = [];
  let segmentsTaken = 0;
  for (const row of pendingSegments) {
    if (segmentsTaken >= segmentLimit) break;
    const record = await verifyRemoteSegmentChain(ctx, row.devH, row.seq);
    const envelope = await readLayoutSegmentEnvelope(ctx, row.key);
    if (!envelope) continue;
    const digest = layoutSegmentEnvelopeDigest(envelope);
    assertTrustedHeadAdvance(state, row.devH, { seq: row.seq, digest });
    record.mutations.forEach((mutation, index) => {
      if (!mutation || typeof mutation !== "object") return;
      const hlc = String(mutation.hlc ?? `${record.created_at}#${index}`);
      mergeItems.push({
        hlc,
        devH: row.devH,
        seq: row.seq,
        index,
        mutation,
        deviceUuid: record.dev,
        segmentCreatedAt: record.created_at,
      });
    });
    advanceVectorCursorDevH(cursor, row.devH, row.seq);
    segmentsTaken += 1;
  }

  const sorted = sortMergeableMutations(mergeItems);
  /** @type {object[]} */
  const changes = [];
  for (const item of sorted) {
    state.changeOrdinal += 1;
    const m = item.mutation;
    const change = {
      sequence: state.changeOrdinal,
      op: m.op,
      context_id: m.context_id ?? null,
      client_id: m.client_id,
      payload: m.payload ?? {},
      device_id: item.deviceUuid,
      created_at: item.segmentCreatedAt,
    };
    changes.push(change);
    let payload = m.payload && typeof m.payload === "object" ? { ...m.payload } : {};
    if (m.op === "message_update") {
      const rows = Array.isArray(payload.messages) ? payload.messages : payload.data;
      if (Array.isArray(rows)) {
        payload.affected_client_ids = rows
          .map((row) => row?.metadata?.ic_client_node_id ?? row?.id)
          .filter(Boolean);
      }
    }
    if (m.op === "message_delete") {
      const ids = payload.ids;
      payload.deleted_client_ids = Array.isArray(ids) ? ids.map(String) : ids !== undefined ? [String(ids)] : [];
    }
    state.ledger.push({
      headSum: vectorCursorHeadSum(cursor),
      op: m.op,
      context_id: m.context_id ?? null,
      client_id: m.client_id,
      payload,
      clientNodeId: payload.affected_client_ids?.[0],
      messageIndex: payload.message_index,
    });
  }

  state.vectorCursor = cursor;
  ctx.localState.save(state);

  const hasMore = pendingSegments.length > segmentsTaken;
  return {
    changes,
    head_sequence: headSequenceForStatus(state),
    next_since: cursor,
    has_more: hasMore,
    conflicts: state.conflicts,
  };
}

export async function objectStorePushSyncMutations(ctx, mutations) {
  const batch = Array.isArray(mutations) ? mutations : [];
  let state = ctx.localState.load();
  const headSum = headSequenceForStatus(state);
  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const duplicate = [];
  /** @type {object[]} */
  const failed = [];
  /** @type {object[]} */
  const conflicts = [];
  /** @type {object[]} */
  const effects = [];

  const knownIds = await reconcileOwnLogPrefix(ctx, state);
  for (const raw of batch) {
    const clientId = raw?.client_id ? String(raw.client_id) : "";
    if (!clientId) continue;
    if (knownIds.has(clientId)) {
      duplicate.push(clientId);
      continue;
    }

    if (raw.op === "message_delete") {
      const baseSeq = parseStrictBaseSequence(raw.base_sequence ?? raw.payload?.base_sequence);
      if (baseSeq === null) {
        failed.push({
          client_id: clientId,
          code: "invalid_input",
          message:
            raw.base_sequence === undefined && raw.payload?.base_sequence === undefined
              ? "base_sequence is required for message_delete"
              : "Invalid base_sequence",
          retryable: false,
        });
        continue;
      }
      if (baseSeq > headSum) {
        failed.push({
          client_id: clientId,
          code: "invalid_input",
          message: "Invalid base_sequence",
          retryable: false,
        });
        continue;
      }
      const contextId = String(raw.context_id ?? "");
      const idList = resolveDeleteTargetClientIds(raw.payload?.ids, state.ledger, contextId);
      if (hasMessageMutationSinceHeadSum(state.ledger, baseSeq, idList)) {
        conflicts.push({
          id: `conf_${clientId}`,
          context_id: contextId,
          kind: "delete_stale_base",
          client_id: clientId,
          sequence: headSum + 1,
          left_payload: { base_sequence: baseSeq, server_sequence: baseSeq, op: "message_delete" },
          right_payload: { delete_targets: idList },
          created_at: new Date().toISOString(),
          resolved_at: null,
        });
        continue;
      }
    }
  }

  const accepted = batch.filter((raw) => {
    const clientId = raw?.client_id ? String(raw.client_id) : "";
    if (!clientId) return false;
    if (knownIds.has(clientId)) return false;
    return !failed.some((f) => f.client_id === clientId) && !conflicts.some((c) => c.client_id === clientId);
  });

  if (accepted.length > 0) {
    const stamped = accepted.map((m, index) => ({
      ...m,
      hlc: m.hlc ?? `${new Date().toISOString()}#${index}`,
    }));
    let written = false;
    while (!written) {
      const seq = state.selfNextSeq;
      const trustedSelf = state.trustedHeads[ctx.selfDevH];
      const prevDigest =
        seq === 0 ? "" : String(trustedSelf?.digest ?? "");
      const record = {
        dev: ctx.deviceUuid,
        seq,
        prev_digest: prevDigest,
        created_at: new Date().toISOString(),
        mutations: stamped,
      };
      const envelope = encryptLogSegment(ctx.dek, ctx.selfDevH, record);
      const digest = layoutSegmentEnvelopeDigest(envelope);
      const key = logSegmentRelativePath(ctx.layoutPrefix, ctx.selfDevH, seq);
      try {
        await writeLayoutSegmentEnvelope(ctx, key, envelope);
        if (ctx.testHookAfterSegmentWrite) {
          await ctx.testHookAfterSegmentWrite();
        }
        if (!ctx.testHookSkipLocalSaveAfterSegmentWrite) {
          assertTrustedHeadAdvance(state, ctx.selfDevH, { seq, digest });
          state.selfNextSeq = seq + 1;
          advanceVectorCursorDevH(state.vectorCursor, ctx.selfDevH, seq);
          for (const raw of stamped) {
            const clientId = String(raw.client_id);
            knownIds.add(clientId);
            applied.push(clientId);
            effects.push({
              client_id: clientId,
              context_id: raw.context_id ?? raw.payload?.context_id,
            });
            let payload = raw.payload && typeof raw.payload === "object" ? { ...raw.payload } : {};
            if (raw.op === "message_update") {
              const rows = Array.isArray(payload.messages) ? payload.messages : payload.data;
              if (Array.isArray(rows)) {
                payload.affected_client_ids = rows
                  .map((row) => row?.metadata?.ic_client_node_id ?? row?.id)
                  .filter(Boolean);
              }
            }
            if (raw.op === "message_delete") {
              const ids = payload.ids;
              payload.deleted_client_ids = Array.isArray(ids)
                ? ids.map(String)
                : ids !== undefined
                  ? [String(ids)]
                  : [];
            }
            state.ledger.push({
              headSum: vectorCursorHeadSum(state.vectorCursor),
              op: raw.op,
              context_id: raw.context_id ?? null,
              client_id: clientId,
              payload,
            });
          }
          ctx.localState.save(state);
        }
        written = true;
      } catch (err) {
        if (!(err instanceof PreconditionFailedError)) throw err;
        const rediscovered = await reconcileOwnLogPrefix(ctx, state);
        for (const raw of stamped) {
          const clientId = String(raw.client_id);
          if (rediscovered.has(clientId)) {
            duplicate.push(clientId);
          }
        }
        const remaining = stamped.filter((m) => !rediscovered.has(String(m.client_id)));
        if (remaining.length === 0) {
          ctx.localState.save(state);
          written = true;
          break;
        }
        state.selfNextSeq = (state.trustedHeads[ctx.selfDevH]?.seq ?? -1) + 1;
        stamped.splice(0, stamped.length, ...remaining);
      }
    }
  }

  state.conflicts = [...state.conflicts, ...conflicts];
  ctx.localState.save(state);

  return {
    head_sequence: headSequenceForStatus(state),
    applied,
    duplicate,
    conflicts,
    effects,
    failed: failed.length ? failed : undefined,
  };
}

export async function objectStoreFetchSyncConflicts(ctx) {
  const state = ctx.localState.load();
  return { data: state.conflicts };
}

export {
  deriveDevH,
  ObjectStoreLogForkError,
  ObjectStoreLogRollbackError,
  compareMergeableMutations,
  sortMergeableMutations,
};
