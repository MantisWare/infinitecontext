import {
  advanceVectorCursorDevH,
  normalizeVectorSyncCursor,
  vectorCursorHeadSum,
} from "./sync-cursor.mjs";

import {
  assertOwnPrefixHeadChainsFromTrust,
  verifyDeviceLogThroughSeq,
} from "./object-store-chain-verify.mjs";
import {
  commitTrustedHeadAdvance,
  computeHeadSequenceFromTrustedHeads,
  createEmptyObjectStoreLocalSyncState,
  headSequenceForStatus,
  ObjectStoreLogForkError,
  ObjectStoreLogRollbackError,
} from "./object-store-local-sync-state.mjs";
import {
  buildDeleteStaleBaseConflict,
  hasMessageUpdateSinceVectorBase,
  snapshotVectorCursor,
} from "./object-store-delete-stale.mjs";
import {
  mergeableFromMutation,
  sortMergeableMutations,
} from "./object-store-merge.mjs";
import {
  nextLocalMutationHlc,
  observeRemoteHlc,
  serializeMutationHlc,
} from "./object-store-hlc.mjs";
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
 * @param {string} devH
 * @param {number} seq
 */
async function readEnvelopeAtSeq(ctx, devH, seq) {
  const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
  return readLayoutSegmentEnvelope(ctx, key);
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
 * @param {number} afterSeq inclusive cursor (-1 = none)
 */
async function listSegmentKeysForDevHAfter(ctx, devH, afterSeq) {
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/${devH.toLowerCase()}/`;
  const startAfter =
    afterSeq >= 0 ? logSegmentRelativePath(ctx.layoutPrefix, devH, afterSeq) : undefined;
  /** @type {string[]} */
  const keys = [];
  let cursor = startAfter;
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (parsed && parsed.devH === devH && parsed.seq > afterSeq) {
        keys.push(row.key);
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  keys.sort((a, b) => (parseLogSegmentKey(a)?.seq ?? 0) - (parseLogSegmentKey(b)?.seq ?? 0));
  return keys;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH
 */
async function maxRemoteSeqForDevH(ctx, devH) {
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/${devH.toLowerCase()}/`;
  let maxSeq = -1;
  let cursor = undefined;
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (parsed?.devH === devH && parsed.seq > maxSeq) maxSeq = parsed.seq;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return maxSeq;
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {Record<string, number>} remoteMaxByDevH
 */
function assertNoRemoteRollback(state, remoteMaxByDevH) {
  for (const [devH, trusted] of Object.entries(state.trustedHeads)) {
    if (!trusted) continue;
    const remoteMax = remoteMaxByDevH[devH];
    if (remoteMax !== undefined && remoteMax >= 0 && remoteMax < trusted.seq) {
      throw new ObjectStoreLogRollbackError(
        `Remote log for ${devH} rolled back (trusted seq ${trusted.seq}, remote max ${remoteMax})`,
      );
    }
  }
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {{ seq: number, digest: string }} trusted
 */
async function assertTrustedAnchorDigest(ctx, devH, trusted) {
  const envelope = await readEnvelopeAtSeq(ctx, devH, trusted.seq);
  if (!envelope) {
    throw new ObjectStoreLogRollbackError(
      `Remote log for ${devH} missing trusted segment at seq ${trusted.seq}`,
    );
  }
  const digest = layoutSegmentEnvelopeDigest(envelope);
  if (digest !== trusted.digest) {
    throw new ObjectStoreLogForkError(`Remote log fork at ${devH} seq ${trusted.seq}`);
  }
}

/**
 * Re-check trusted tip and its prev_digest link (catches mid-chain rewrite after TOFU).
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {{ seq: number, digest: string }} trusted
 */
async function assertTrustedHeadIntegrity(ctx, devH, trusted) {
  await assertTrustedAnchorDigest(ctx, devH, trusted);
  if (trusted.seq === 0) return;
  const prevEnvelope = await readEnvelopeAtSeq(ctx, devH, trusted.seq - 1);
  if (!prevEnvelope) {
    throw new ObjectStoreLogRollbackError(
      `Remote log for ${devH} missing segment at seq ${trusted.seq - 1}`,
    );
  }
  const curEnvelope = await readEnvelopeAtSeq(ctx, devH, trusted.seq);
  if (!curEnvelope) {
    throw new ObjectStoreLogRollbackError(
      `Remote log for ${devH} missing trusted segment at seq ${trusted.seq}`,
    );
  }
  const prevDigest = layoutSegmentEnvelopeDigest(prevEnvelope);
  const record = decryptLogSegment(ctx.dek, devH, trusted.seq, curEnvelope);
  if (record.prev_digest !== prevDigest) {
    throw new ObjectStoreLogForkError(
      `Log segment prev_digest mismatch at ${devH} seq ${trusted.seq}`,
    );
  }
}

/**
 * Owner-side: re-verify cached trusted prefix exists and matches on every push.
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {{ seq: number, digest: string }} trusted
 */
async function verifyOwnerTrustedPrefix(ctx, devH, trusted) {
  await assertTrustedAnchorDigest(ctx, devH, trusted);
  await verifyDeviceLogThroughSeq(
    ctx,
    devH,
    undefined,
    (seq) => readEnvelopeAtSeq(ctx, devH, seq),
    trusted.seq,
  );
}

/** @param {ObjectStoreSyncContext} ctx @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state */
async function assertTrustedAnchorsMatchRemote(ctx, state) {
  for (const [devH, trusted] of Object.entries(state.trustedHeads)) {
    if (!trusted) continue;
    await assertTrustedHeadIntegrity(ctx, devH, trusted);
  }
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

/** @param {import('./object-store-merge.mjs').MergeableMutation} item */
function hostedPayloadFromMutation(item) {
  const m = item.mutation;
  const payload = m.payload && typeof m.payload === "object" ? { ...m.payload } : {};
  if (m.op === "message_append" || m.op === "message_update") {
    const rows = Array.isArray(payload.messages) ? payload.messages : payload.data;
    if (Array.isArray(rows)) {
      payload.data = rows;
      payload.affected_client_ids = rows
        .map((r) => r?.metadata?.ic_client_node_id ?? r?.id)
        .filter(Boolean);
    }
  }
  if (m.op === "message_delete") {
    const ids = payload.ids;
    payload.deleted_client_ids = Array.isArray(ids) ? ids.map(String) : ids !== undefined ? [String(ids)] : [];
  }
  if (m.op === "context_create") {
    payload.context_id = payload.context_id ?? m.context_id;
  }
  return payload;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./sync-cursor.mjs').VectorSyncCursor} planBase
 * @param {string} contextId
 * @param {string[]} targetClientIds
 */
async function hasRemoteMessageUpdateSinceVectorBase(ctx, planBase, contextId, targetClientIds) {
  const targets = new Set(targetClientIds);
  const base = planBase.v ?? {};
  const devHs = new Set([...Object.keys(base), ...Object.keys(ctx.localState.load().trustedHeads ?? {})]);
  for (const devH of devHs) {
    const after = Object.prototype.hasOwnProperty.call(base, devH) ? Number(base[devH]) : -1;
    const keys = await listSegmentKeysForDevHAfter(ctx, devH, after);
    for (const key of keys) {
      const parsed = parseLogSegmentKey(key);
      if (!parsed) continue;
      const envelope = await readLayoutSegmentEnvelope(ctx, key);
      if (!envelope) continue;
      const record = decryptLogSegment(ctx.dek, devH, parsed.seq, envelope);
      for (const mutation of record.mutations) {
        if (!mutation || typeof mutation !== "object") continue;
        const op = String(mutation.op ?? "");
        if (op !== "message_update" && op !== "message_append") continue;
        if (String(mutation.context_id ?? "") !== contextId) continue;
        const payload = mutation.payload && typeof mutation.payload === "object" ? mutation.payload : {};
        const rows = Array.isArray(payload.messages) ? payload.messages : [];
        for (const row of rows) {
          const cid = row?.metadata?.ic_client_node_id ?? row?.id;
          if (typeof cid === "string" && targets.has(cid)) return true;
        }
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
  const trustedSelf = state.trustedHeads[ctx.selfDevH];
  if (trustedSelf) {
    await verifyOwnerTrustedPrefix(ctx, ctx.selfDevH, trustedSelf);
  }
  const afterSeq = trustedSelf?.seq ?? -1;
  const keys = await listSegmentKeysForDevHAfter(ctx, ctx.selfDevH, -1);
  /** @type {Set<string>} */
  const clientIds = new Set();
  if (keys.length === 0) {
    return clientIds;
  }
  let maxSeq = afterSeq;
  let lastDigest = trustedSelf?.digest ?? "";
  for (const key of keys) {
    const parsed = parseLogSegmentKey(key);
    if (!parsed) continue;
    const envelope = await readLayoutSegmentEnvelope(ctx, key);
    if (!envelope) continue;
    const record = decryptLogSegment(ctx.dek, ctx.selfDevH, parsed.seq, envelope);
    for (const m of record.mutations) {
      if (m?.client_id) clientIds.add(String(m.client_id));
    }
    if (parsed.seq > maxSeq) {
      maxSeq = parsed.seq;
      lastDigest = layoutSegmentEnvelopeDigest(envelope);
    }
  }
  if (maxSeq > afterSeq) {
    const candidate = { seq: maxSeq, digest: lastDigest };
    await assertOwnPrefixHeadChainsFromTrust(
      ctx,
      ctx.selfDevH,
      trustedSelf,
      (seq) => readEnvelopeAtSeq(ctx, ctx.selfDevH, seq),
      candidate,
    );
    commitTrustedHeadAdvance(state, ctx.selfDevH, candidate);
    state.selfNextSeq = maxSeq + 1;
  }
  return clientIds;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./sync-cursor.mjs').VectorSyncCursor} cursor
 */
async function discoverPendingSegments(ctx, state, cursor) {
  /** @type {{ devH: string, seq: number, key: string }[]} */
  const pending = [];
  /** @type {Record<string, number>} */
  const remoteMaxByDevH = {};

  const devHs = new Set([
    ...Object.keys(state.trustedHeads),
    ...Object.keys(cursor.v ?? {}),
  ]);

  const logPrefix = `${layoutRootPath(ctx.layoutPrefix)}/log/`;
  let listCursor = state.logListCursor || undefined;
  for (;;) {
    const page = await ctx.adapter.list(logPrefix, { limit: 500, cursor: listCursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (!parsed) continue;
      devHs.add(parsed.devH);
      remoteMaxByDevH[parsed.devH] = Math.max(remoteMaxByDevH[parsed.devH] ?? -1, parsed.seq);
    }
    if (!page.nextCursor) {
      state.logListCursor = "";
      break;
    }
    listCursor = page.nextCursor;
    state.logListCursor = listCursor;
  }

  for (const devH of devHs) {
    if (remoteMaxByDevH[devH] === undefined) {
      remoteMaxByDevH[devH] = await maxRemoteSeqForDevH(ctx, devH);
    }
  }
  assertNoRemoteRollback(state, remoteMaxByDevH);
  await assertTrustedAnchorsMatchRemote(ctx, state);

  for (const devH of devHs) {
    const after = cursor.v[devH] ?? -1;
    const keys = await listSegmentKeysForDevHAfter(ctx, devH, after);
    for (const key of keys) {
      const parsed = parseLogSegmentKey(key);
      if (parsed) pending.push({ devH: parsed.devH, seq: parsed.seq, key });
    }
  }
  pending.sort((a, b) => {
    if (a.devH !== b.devH) return a.devH.localeCompare(b.devH);
    return a.seq - b.seq;
  });
  return pending;
}

export async function objectStoreFetchSyncStatus(ctx) {
  const state = ctx.localState.load();
  return { head_sequence: headSequenceForStatus(state) };
}

export async function objectStorePullSyncChanges(ctx, options = {}) {
  const segmentLimit = options.limit ?? 500;
  const state = ctx.localState.load();
  const cursor = normalizeVectorSyncCursor(options.since ?? state.vectorCursor);

  const pendingSegments = await discoverPendingSegments(ctx, state, cursor);

  /** @type {import('./object-store-merge.mjs').MergeableMutation[]} */
  const mergeItems = [];
  let segmentsTaken = 0;
  for (const row of pendingSegments) {
    if (segmentsTaken >= segmentLimit) break;
    const trusted = state.trustedHeads[row.devH];
    await verifyDeviceLogThroughSeq(
      ctx,
      row.devH,
      trusted,
      (seq) => readEnvelopeAtSeq(ctx, row.devH, seq),
      row.seq,
    );
    const envelope = await readLayoutSegmentEnvelope(ctx, row.key);
    if (!envelope) continue;
    const digest = layoutSegmentEnvelopeDigest(envelope);
    commitTrustedHeadAdvance(state, row.devH, { seq: row.seq, digest });
    const record = decryptLogSegment(ctx.dek, row.devH, row.seq, envelope);
    record.mutations.forEach((mutation, index) => {
      if (!mutation || typeof mutation !== "object") return;
      const item = mergeableFromMutation(
        mutation,
        row.devH,
        row.seq,
        index,
        record.dev,
        record.created_at,
      );
      observeRemoteHlc(state, item.hlcTuple);
      mergeItems.push(item);
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
    const payload = hostedPayloadFromMutation(item);
    const change = {
      sequence: state.changeOrdinal,
      op: m.op,
      context_id: m.context_id ?? null,
      client_id: m.client_id,
      payload,
      device_id: item.deviceUuid,
      created_at: item.segmentCreatedAt,
      hlc: serializeMutationHlc(item.hlcTuple),
      source_dev_h: item.devH,
      source_seq: item.seq,
      source_index: item.index,
    };
    changes.push(change);
    state.ledger.push({
      headSum: computeHeadSequenceFromTrustedHeads(state),
      op: m.op,
      context_id: m.context_id ?? null,
      client_id: m.client_id,
      payload,
      clientNodeId: payload.affected_client_ids?.[0],
      messageIndex: payload.message_index,
      sourceDevH: item.devH,
      sourceSeq: item.seq,
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

  let knownIds;
  try {
    knownIds = await reconcileOwnLogPrefix(ctx, state);
  } catch (err) {
    if (err instanceof ObjectStoreLogForkError || err instanceof ObjectStoreLogRollbackError) {
      ctx.localState.save(state);
      throw err;
    }
    throw err;
  }

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
      const planBase = raw.base_vector
        ? snapshotVectorCursor(normalizeVectorSyncCursor(raw.base_vector))
        : snapshotVectorCursor(state.vectorCursor);
      const staleLocal = hasMessageUpdateSinceVectorBase(state.ledger, planBase, idList);
      const staleRemote = await hasRemoteMessageUpdateSinceVectorBase(ctx, planBase, contextId, idList);
      if (staleLocal || staleRemote) {
        conflicts.push(
          buildDeleteStaleBaseConflict({
            client_id: clientId,
            context_id: contextId,
            base_vector: planBase,
            delete_targets: idList,
          }),
        );
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
    const stamped = accepted.map((m) => {
      const hlcTuple = nextLocalMutationHlc(state, ctx.selfDevH);
      return {
        ...m,
        hlc: serializeMutationHlc(hlcTuple),
      };
    });
    let written = false;
    while (!written) {
      const seq = state.selfNextSeq;
      const trustedSelf = state.trustedHeads[ctx.selfDevH];
      const prevDigest = seq === 0 ? "" : String(trustedSelf?.digest ?? "");
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
          commitTrustedHeadAdvance(state, ctx.selfDevH, { seq, digest });
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
                  .map((r) => r?.metadata?.ic_client_node_id ?? r?.id)
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
              headSum: computeHeadSequenceFromTrustedHeads(state),
              op: raw.op,
              context_id: raw.context_id ?? null,
              client_id: clientId,
              payload,
              sourceDevH: ctx.selfDevH,
              sourceSeq: seq,
            });
          }
          ctx.localState.save(state);
        }
        written = true;
      } catch (err) {
        if (err instanceof ObjectStoreLogForkError || err instanceof ObjectStoreLogRollbackError) {
          ctx.localState.save(state);
          throw err;
        }
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
  sortMergeableMutations,
};
