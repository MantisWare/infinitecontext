import {
  advanceVectorCursorDevH,
  maxVectorSyncCursor,
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
  ObjectStoreLogMissingError,
  ObjectStoreLogRollbackError,
} from "./object-store-local-sync-state.mjs";
import {
  capturePullApplyBaseline,
  restorePullApplyBaseline,
  stashPendingPullDeliveryApply,
} from "./object-store-pull-delivery.mjs";
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
  HLC_MAX_SKEW_MS,
  nextLocalMutationHlc,
  observeRemoteHlc,
  parseMutationHlc,
  serializeMutationHlc,
} from "./object-store-hlc.mjs";
import { saveObjectStoreLocalStateBestEffort } from "./object-store-local-state-persist.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "./storage/encrypt-storage-object.mjs";
import { PreconditionFailedError, StorageError } from "./storage/errors.mjs";
import { isInjectedTestHookActive } from "./storage/test-hooks.mjs";
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
import {
  bootstrapLocalStateFromLatestSnapshot,
  confirmObjectStorePullDelivery,
} from "./storage/storage-compaction.mjs";
import {
  loadStorageManifestForSync,
  registerManifestSyncParticipant,
} from "./storage/storage-manifest.mjs";
import { writeDeviceSyncAckFromState } from "./storage/storage-device-sync-ack.mjs";
import {
  bootstrapVerifiedSnapshotFloorCatchUp,
  ensureManifestVerifiedSnapshotFloors,
  verifiedSnapshotFloorForDevH,
  vectorCursorBelowManifestFloor,
} from "./object-store-snapshot-floor.mjs";

const LAYOUT_SEGMENT_PLAIN_FIELD = "ic_layout_segment_envelope_v1";
const FULL_CHAIN_VERIFY_EVERY_N = 32;
let pullsSinceBoot = 0;

/** Reset for tests. */
export function resetObjectStorePullVerifyGenerationForTests() {
  pullsSinceBoot = 0;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {{ bestEffort?: boolean }} [options]
 */
async function persistLocalState(ctx, state, options = {}) {
  if (options.bestEffort) {
    await saveObjectStoreLocalStateBestEffort(ctx.localState, state);
    return;
  }
  await ctx.localState.save(state);
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
async function assertFolderManifestTrustedHeadsVerifiable(ctx, manifest) {
  for (const [devH, head] of Object.entries(manifest.trusted_heads ?? {})) {
    if (!head || head.seq < 0) continue;
    await verifyDeviceLogThroughSeq(
      ctx,
      devH,
      undefined,
      (seq) => readEnvelopeAtSeq(ctx, devH, seq),
      head.seq,
    );
    const env = await readEnvelopeAtSeq(ctx, devH, head.seq);
    if (!env) {
      throw new ObjectStoreLogRollbackError(
        `Remote log for ${devH} missing owner-written head at seq ${head.seq}`,
      );
    }
    if (layoutSegmentEnvelopeDigest(env) !== head.digest) {
      throw new ObjectStoreLogForkError(`Remote log fork at ${devH} seq ${head.seq}`);
    }
  }
}

async function verifyFullTrustedChains(ctx, state, manifest) {
  await maybeAdoptVerifiedSnapshotFloors(ctx, state, manifest);
  for (const [devH, trusted] of Object.entries(state.trustedHeads)) {
    if (!trusted || trusted.seq < 0) continue;
    await verifyDeviceLogThroughSeq(
      ctx,
      devH,
      trusted,
      (seq) => readEnvelopeAtSeq(ctx, devH, seq),
      trusted.seq,
    );
    await assertLogContiguousToHead(ctx, state, manifest, devH, trusted);
  }
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {number} seq
 * @param {import('./ic-crypto.mjs').AeadEnvelope} envelope
 */
function segmentClockSkewWallMs(ctx, devH, seq, envelope) {
  const record = decryptLogSegment(ctx.dek, devH, seq, envelope);
  const limit = Date.now() + HLC_MAX_SKEW_MS;
  let maxWall = null;
  for (const mutation of record.mutations) {
    const hlc = parseMutationHlc(mutation?.hlc, devH);
    if (hlc && hlc.wall_ms > limit) {
      maxWall = maxWall === null ? hlc.wall_ms : Math.max(maxWall, hlc.wall_ms);
    }
  }
  if (maxWall !== null && Date.now() >= maxWall - HLC_MAX_SKEW_MS) {
    return null;
  }
  return maxWall;
}

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
  /** @type {import('./storage/types.mjs').StorageGetResult[]} */
  let rows = [];
  const conflictAware = /** @type {{ listConflictGetCandidates?: (k: string) => Promise<import('./storage/types.mjs').StorageGetResult[]> }} */ (
    ctx.adapter
  ).listConflictGetCandidates;
  if (typeof conflictAware === "function") {
    rows = await conflictAware.call(ctx.adapter, key);
  } else {
    const row = await ctx.adapter.get(key);
    if (row) rows = [row];
  }
  /** @type {import('./ic-crypto.mjs').AeadEnvelope[]} */
  const envelopes = [];
  for (const row of rows) {
    if (!row?.body) continue;
    try {
      const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
      const envelope = plain[LAYOUT_SEGMENT_PLAIN_FIELD] ?? null;
      if (envelope) envelopes.push(envelope);
    } catch {
      /* try next conflict copy */
    }
  }
  if (!envelopes.length) {
    if (rows.length > 0) {
      throw new StorageError(`Undecryptable or foreign-key conflict copy for ${key}`, "corrupt_storage");
    }
    if (typeof conflictAware === "function") {
      const dirs = /** @type {{ rootDir?: string }} */ (ctx.adapter).rootDir;
      if (dirs) {
        const { physicalKeyDirsForCanonicalKey } = await import("./storage/folder-on-disk-scan.mjs");
        const physical = physicalKeyDirsForCanonicalKey(dirs, key);
        if (physical.length > 1) {
          throw new StorageError(`Conflicting sync copies for log segment ${key}`, "corrupt_storage");
        }
      }
    }
    return null;
  }
  const { layoutSegmentEnvelopeDigest } = await import("./storage/layout.mjs");
  const digest = layoutSegmentEnvelopeDigest(envelopes[0]);
  for (let i = 1; i < envelopes.length; i += 1) {
    if (layoutSegmentEnvelopeDigest(envelopes[i]) !== digest) {
      throw new ObjectStoreLogForkError(`Conflicting sync copies for log segment ${key}`);
    }
  }
  return envelopes[0];
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

/** @param {ObjectStoreSyncContext} ctx */
async function listAllLogDevHs(ctx) {
  const logRoot = `${layoutRootPath(ctx.layoutPrefix)}/log/`;
  /** @type {Set<string>} */
  const devHs = new Set();
  let cursor = undefined;
  for (;;) {
    const page = await ctx.adapter.list(logRoot, { limit: 500, cursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (parsed?.devH) devHs.add(parsed.devH);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return devHs;
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
/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
async function maybeAdoptVerifiedSnapshotFloors(ctx, state, manifest) {
  if (vectorCursorBelowManifestFloor(state, manifest)) return;
  const adopted = await ensureManifestVerifiedSnapshotFloors(ctx, state, manifest, (devH, seq) =>
    readEnvelopeAtSeq(ctx, devH, seq),
  );
  if (adopted) {
    await persistLocalState(ctx, state);
  }
}

/** @param {ObjectStoreSyncContext} ctx @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest */
function assertDeviceNotRemoved(ctx, manifest) {
  if ((manifest.removed_devices ?? []).includes(ctx.selfDevH)) {
    throw new ObjectStoreLogRollbackError(
      `Device ${ctx.selfDevH} was removed from sync; register a new device identity to continue`,
    );
  }
}

/** @param {ObjectStoreSyncContext} ctx @param {string} devH */
async function listPresentSeqsForDevH(ctx, devH) {
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/${devH.toLowerCase()}/`;
  /** @type {Set<number>} */
  const seqs = new Set();
  let listCursor = undefined;
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor: listCursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (parsed?.devH === devH) seqs.add(parsed.seq);
    }
    if (!page.nextCursor) break;
    listCursor = page.nextCursor;
  }
  return seqs;
}

/**
 * @param {ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {string} devH
 * @param {{ seq: number, digest: string }} trusted
 */
async function assertLogContiguousToHead(ctx, state, manifest, devH, trusted) {
  if (!trusted || trusted.seq < 0) return;
  await maybeAdoptVerifiedSnapshotFloors(ctx, state, manifest);
  let startSeq = 0;
  const floor = verifiedSnapshotFloorForDevH(state, manifest, devH);
  if (floor >= 0) startSeq = floor + 1;
  const present = await listPresentSeqsForDevH(ctx, devH);
  for (let seq = startSeq; seq <= trusted.seq; seq += 1) {
    if (!present.has(seq)) {
      throw new ObjectStoreLogMissingError(`Remote log for ${devH} missing segment at seq ${seq}`);
    }
  }
  await assertTrustedAnchorDigest(ctx, devH, trusted);
  if (trusted.seq === 0) return;
  const prevEnvelope = await readEnvelopeAtSeq(ctx, devH, trusted.seq - 1);
  const curEnvelope = await readEnvelopeAtSeq(ctx, devH, trusted.seq);
  if (!curEnvelope) {
    throw new ObjectStoreLogMissingError(
      `Remote log for ${devH} missing trusted segment at seq ${trusted.seq}`,
    );
  }
  if (prevEnvelope) {
    const prevDigest = layoutSegmentEnvelopeDigest(prevEnvelope);
    const record = decryptLogSegment(ctx.dek, devH, trusted.seq, curEnvelope);
    if (record.prev_digest !== prevDigest) {
      throw new ObjectStoreLogForkError(
        `Log segment prev_digest mismatch at ${devH} seq ${trusted.seq}`,
      );
    }
  }
}

/**
 * Owner-side: re-verify cached trusted prefix exists and matches on every push.
 * @param {ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {{ seq: number, digest: string }} trusted
 */
async function verifyOwnerTrustedPrefix(ctx, manifest, devH, trusted) {
  const state = ctx.localState.load();
  await assertLogContiguousToHead(ctx, state, manifest, devH, trusted);
}

/** @param {ObjectStoreSyncContext} ctx @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest */
async function assertTrustedAnchorsMatchRemote(ctx, state, manifest) {
  await maybeAdoptVerifiedSnapshotFloors(ctx, state, manifest);
  for (const [devH, trusted] of Object.entries(state.trustedHeads)) {
    if (!trusted || trusted.seq < 0) continue;
    await assertLogContiguousToHead(ctx, state, manifest, devH, trusted);
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
  if (m.op === "message_delete" || m.op === "message_update") {
    if (m.op === "message_delete") {
      const ids = payload.ids;
      payload.deleted_client_ids = Array.isArray(ids) ? ids.map(String) : ids !== undefined ? [String(ids)] : [];
    }
    const baseVector = m.base_vector ?? payload.base_vector;
    if (baseVector) payload.base_vector = baseVector;
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
  const devHs = await listAllLogDevHs(ctx);
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
  let trustedSelf = state.trustedHeads[ctx.selfDevH];
  const manifest = await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, state);
  const manifestHead = manifest.trusted_heads?.[ctx.selfDevH];
  if (
    manifestHead &&
    (!trustedSelf ||
      manifestHead.seq > trustedSelf.seq ||
      (manifestHead.seq === trustedSelf.seq && manifestHead.digest !== trustedSelf.digest))
  ) {
    commitTrustedHeadAdvance(state, ctx.selfDevH, manifestHead);
    trustedSelf = manifestHead;
  }
  if (trustedSelf) {
    await verifyOwnerTrustedPrefix(ctx, manifest, ctx.selfDevH, trustedSelf);
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
async function discoverPendingSegments(ctx, state, cursor, manifest) {
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
  await assertTrustedAnchorsMatchRemote(ctx, state, manifest);

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

function resolvePullVectorCursor(state, since) {
  const fromState = normalizeVectorSyncCursor(state.vectorCursor);
  if (since && typeof since === "object" && since.kind === "vector") {
    return maxVectorSyncCursor(normalizeVectorSyncCursor(since), fromState);
  }
  return fromState;
}

export async function objectStorePullSyncChanges(ctx, options = {}) {
  const segmentLimit = options.limit ?? 500;
  let state = ctx.localState.load();
  const { usesFolderMergedDeviceManifest } = await import("./storage/storage-adapter-policy.mjs");
  if (usesFolderMergedDeviceManifest(ctx.adapter)) {
    const { repairOwnDeviceManifestFileIfAuthoritative } = await import(
      "./storage/storage-manifest-folder-repair.mjs"
    );
    await repairOwnDeviceManifestFileIfAuthoritative(ctx);
  }
  const manifest = await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, state);
  if (usesFolderMergedDeviceManifest(ctx.adapter)) {
    const { assertFolderObjectFileCopiesClean, assertFolderCopyFolderDirsClean } = await import(
      "./storage/folder-object-conflict-preflight.mjs"
    );
    await assertFolderObjectFileCopiesClean(ctx.adapter, ctx.layoutPrefix);
    await assertFolderCopyFolderDirsClean(ctx.adapter, ctx.layoutPrefix);
    await assertFolderManifestTrustedHeadsVerifiable(ctx, manifest);
  }
  assertDeviceNotRemoved(ctx, manifest);
  state = ctx.localState.load();
  const pendingDelivery = Boolean(state.pendingBootstrapReplica && state.bootstrapReplicaPendingAck);
  if (!pendingDelivery) {
    await bootstrapLocalStateFromLatestSnapshot(ctx, state);
    await bootstrapVerifiedSnapshotFloorCatchUp(ctx, state, manifest, (devH, seq) =>
      readEnvelopeAtSeq(ctx, devH, seq),
    );
  }
  const pullBaseline = capturePullApplyBaseline(state);
  const cursor = resolvePullVectorCursor(state, options.since);

  pullsSinceBoot += 1;
  if (
    !pendingDelivery &&
    (pullsSinceBoot === 1 || pullsSinceBoot % FULL_CHAIN_VERIFY_EVERY_N === 0)
  ) {
    await verifyFullTrustedChains(ctx, state, manifest);
  }

  const pendingSegments = await discoverPendingSegments(ctx, state, cursor, manifest);

  /** @type {import('./object-store-merge.mjs').MergeableMutation[]} */
  const mergeItems = [];
  /** @type {Set<string>} */
  const skewBlockedDevH = new Set();
  /** @type {object[]} */
  const clockSkew = [];
  let segmentsTaken = 0;
  for (const row of pendingSegments) {
    if (segmentsTaken >= segmentLimit) break;
    if (skewBlockedDevH.has(row.devH)) continue;
    const envelope = await readLayoutSegmentEnvelope(ctx, row.key);
    if (!envelope) continue;
    const skewWall = segmentClockSkewWallMs(ctx, row.devH, row.seq, envelope);
    if (skewWall !== null) {
      const resumeAtMs = skewWall - HLC_MAX_SKEW_MS;
      clockSkew.push({
        code: "clock_skew",
        dev_h: row.devH,
        wall_ms: skewWall,
        local_now: Date.now(),
        max_skew_ms: HLC_MAX_SKEW_MS,
        resume_at_ms: resumeAtMs,
        message: `Remote HLC ahead of local clock; pull resumes once local time reaches ${new Date(resumeAtMs).toISOString()}`,
      });
      skewBlockedDevH.add(row.devH);
      continue;
    }
    const trusted = state.trustedHeads[row.devH];
    await verifyDeviceLogThroughSeq(
      ctx,
      row.devH,
      trusted,
      (seq) => readEnvelopeAtSeq(ctx, row.devH, seq),
      row.seq,
    );
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
    if (m.op === "message_delete" || m.op === "message_update") {
      const baseVector = m.base_vector ?? payload.base_vector;
      if (baseVector) change.base_vector = baseVector;
    }
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
  /** @type {import('./sync-cursor.mjs').VectorSyncCursor} */
  let nextSince = cursor;
  if (state.bootstrapReplicaPendingAck && segmentsTaken > 0) {
    stashPendingPullDeliveryApply(state, pullBaseline, capturePullApplyBaseline(state));
    restorePullApplyBaseline(state, pullBaseline);
    nextSince = normalizeVectorSyncCursor(state.pendingPullDeliveryApply?.vectorCursor ?? cursor);
  }
  /** @type {Record<string, unknown> | undefined} */
  let bootstrapReplica;
  if (state.pendingBootstrapReplica) {
    bootstrapReplica = state.pendingBootstrapReplica;
  }
  await persistLocalState(ctx, state);

  const hasMore = pendingSegments.length > segmentsTaken;
  const statusState = ctx.localState.load();
  return {
    changes,
    bootstrap_replica: bootstrapReplica,
    head_sequence: headSequenceForStatus(statusState),
    next_since: nextSince,
    has_more: hasMore,
    conflicts: state.conflicts,
    clock_skew: clockSkew.length ? clockSkew : undefined,
  };
}

export async function confirmObjectStorePullDeliveryForContext(ctx) {
  await confirmObjectStorePullDelivery(ctx);
}

function resolveSelfNextSeq(state, selfDevH) {
  const trusted = state.trustedHeads[selfDevH];
  if (!trusted || trusted.seq < 0) return 0;
  return Math.max(state.selfNextSeq ?? 0, trusted.seq + 1);
}

export async function objectStorePushSyncMutations(ctx, mutations) {
  const batch = Array.isArray(mutations) ? mutations : [];
  let state = ctx.localState.load();
  const { usesFolderMergedDeviceManifest } = await import("./storage/storage-adapter-policy.mjs");
  if (usesFolderMergedDeviceManifest(ctx.adapter)) {
    const { assertFolderObjectFileCopiesClean, assertFolderCopyFolderDirsClean } = await import(
      "./storage/folder-object-conflict-preflight.mjs"
    );
    await assertFolderObjectFileCopiesClean(ctx.adapter, ctx.layoutPrefix);
    await assertFolderCopyFolderDirsClean(ctx.adapter, ctx.layoutPrefix);
  }
  const manifest = await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, state);
  assertDeviceNotRemoved(ctx, manifest);
  await registerManifestSyncParticipant(
    {
      adapter: ctx.adapter,
      dek: ctx.dek,
      layoutPrefix: ctx.layoutPrefix,
      ownerDevH: ctx.selfDevH,
      settleMs: 0,
    },
    ctx.selfDevH,
  );
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
      await persistLocalState(ctx, state);
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
      if (!raw.base_vector && !raw.payload?.base_vector) {
        failed.push({
          client_id: clientId,
          code: "invalid_input",
          message: "base_vector is required for message_delete",
          retryable: false,
        });
        continue;
      }
      const contextId = String(raw.context_id ?? "");
      const idList = resolveDeleteTargetClientIds(raw.payload?.ids, state.ledger, contextId);
      const planBase = snapshotVectorCursor(
        normalizeVectorSyncCursor(raw.base_vector ?? raw.payload?.base_vector),
      );
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

    if (raw.op === "message_update") {
      if (!raw.base_vector && !raw.payload?.base_vector) {
        failed.push({
          client_id: clientId,
          code: "invalid_input",
          message: "base_vector is required for message_update",
          retryable: false,
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
    const stamped = accepted.map((m) => {
      const hlcTuple = nextLocalMutationHlc(state, ctx.selfDevH);
      /** @type {Record<string, unknown>} */
      const out = {
        ...m,
        hlc: serializeMutationHlc(hlcTuple),
      };
      if (m.op === "message_update") {
        const base_vector = snapshotVectorCursor(
          normalizeVectorSyncCursor(m.base_vector ?? m.payload?.base_vector),
        );
        out.base_vector = base_vector;
        out.payload = { ...(m.payload && typeof m.payload === "object" ? m.payload : {}), base_vector };
      }
      return out;
    });
    let written = false;
    state.selfNextSeq = resolveSelfNextSeq(state, ctx.selfDevH);
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
        if (isInjectedTestHookActive(ctx, "testHookAfterSegmentWrite")) {
          await ctx.testHookAfterSegmentWrite();
        }
        if (!isInjectedTestHookActive(ctx, "testHookSkipLocalSaveAfterSegmentWrite")) {
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
          await persistLocalState(ctx, state, { bestEffort: true });
        }
        written = true;
      } catch (err) {
        if (err instanceof ObjectStoreLogForkError || err instanceof ObjectStoreLogRollbackError) {
          await persistLocalState(ctx, state, { bestEffort: true });
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
          await persistLocalState(ctx, state, { bestEffort: true });
          written = true;
          break;
        }
        state.selfNextSeq = (state.trustedHeads[ctx.selfDevH]?.seq ?? -1) + 1;
        stamped.splice(0, stamped.length, ...remaining);
      }
    }
  }

  state.conflicts = [...state.conflicts, ...conflicts];
  await persistLocalState(ctx, state, { bestEffort: true });
  if (applied.length > 0) {
    await writeDeviceSyncAckFromState(
      {
        adapter: ctx.adapter,
        dek: ctx.dek,
        layoutPrefix: ctx.layoutPrefix,
        ownerDevH: ctx.selfDevH,
        deviceUuid: ctx.deviceUuid,
      },
      ctx.localState.load(),
    );
    await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, ctx.localState.load());
  }

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
  ObjectStoreLogMissingError,
  ObjectStoreLogRollbackError,
  sortMergeableMutations,
};
