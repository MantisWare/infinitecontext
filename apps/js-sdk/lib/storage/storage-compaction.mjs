import {
  advanceVectorCursorDevH,
  maxVectorSyncCursor,
  normalizeVectorSyncCursor,
} from "../sync-cursor.mjs";
import { sanitizeSyncReplicaForPersist } from "../sync-replica-state.mjs";
import {
  commitTrustedHeadAdvance,
  createEmptyObjectStoreLocalSyncState,
} from "../object-store-local-sync-state.mjs";
import { verifyDeviceLogThroughSeq } from "../object-store-chain-verify.mjs";
import {
  layoutRootPath,
  layoutSegmentEnvelopeDigest,
  logSegmentRelativePath,
  snapEncRelativePath,
} from "./layout.mjs";
import {
  loadStorageManifest,
  loadStorageManifestForSync,
  mergeTrustedHeadsMonotonic,
  parseStorageManifestPlain,
  updateStorageManifest,
  upsertManifestDeviceAck,
  wrapStorageManifestPlain,
} from "./storage-manifest.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import { LEASE_DEFAULT_SETTLE_MS } from "./lease-lock.mjs";
import {
  readLayoutObjectPlaintext,
  storageConditionalCreate,
  storageReadModifyWrite,
} from "./storage-cas-rmw.mjs";
import { decryptVaultStorageObjectPlaintext } from "./storage-object-move.mjs";

export const SNAPSHOT_FORMAT = 1;
const SNAPSHOT_PLAIN_FIELD = "ic_layout_snapshot_v1";
const LAYOUT_SEGMENT_PLAIN_FIELD = "ic_layout_segment_envelope_v1";

/**
 * @typedef {Object} StorageSnapshotRecord
 * @property {number} format
 * @property {number} epoch
 * @property {string} created_at
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} compacted_through
 * @property {Record<string, { seq: number, digest: string }>} trusted_heads
 * @property {Record<string, unknown>} replica
 */

/** @param {unknown} raw */
export function parseStorageSnapshotPlain(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid snapshot payload");
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const inner = obj[SNAPSHOT_PLAIN_FIELD] ?? obj;
  const record = inner && typeof inner === "object" ? /** @type {Record<string, unknown>} */ (inner) : {};
  return {
    format: Number(record.format ?? SNAPSHOT_FORMAT),
    epoch: Number(record.epoch ?? 0),
    created_at: String(record.created_at ?? ""),
    compacted_through: normalizeVectorSyncCursor(record.compacted_through ?? 0),
    trusted_heads:
      record.trusted_heads && typeof record.trusted_heads === "object"
        ? /** @type {Record<string, { seq: number, digest: string }>} */ (record.trusted_heads)
        : {},
    replica:
      record.replica && typeof record.replica === "object"
        ? /** @type {Record<string, unknown>} */ (record.replica)
        : {},
  };
}

/** @param {StorageSnapshotRecord} snap */
export function wrapStorageSnapshotPlain(snap) {
  return { [SNAPSHOT_PLAIN_FIELD]: snap };
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
export async function listSnapshotEpochs(ctx) {
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/snap/`;
  /** @type {number[]} */
  const epochs = [];
  let cursor = undefined;
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor });
    for (const row of page.objects) {
      const match = /\/snap\/(\d{8})\.enc$/i.exec(row.key);
      if (match) epochs.push(Number(match[1]));
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  epochs.sort((a, b) => a - b);
  return epochs;
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {number} epoch
 */
export async function loadStorageSnapshot(ctx, epoch) {
  const key = snapEncRelativePath(ctx.layoutPrefix, epoch);
  const row = await ctx.adapter.get(key);
  if (!row?.body) return null;
  const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
  return parseStorageSnapshotPlain(plain);
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {number} seq
 */
async function readEnvelopeAtSeq(ctx, devH, seq) {
  const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
  const row = await ctx.adapter.get(key);
  if (!row?.body) return null;
  const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
  return plain[LAYOUT_SEGMENT_PLAIN_FIELD] ?? null;
}

/**
 * Verify snapshot trusted heads still match remote log (rollback/fork guard).
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {StorageSnapshotRecord} snap
 */
async function assertSnapshotCoversLiveLogHeads(ctx, snap) {
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/`;
  /** @type {Record<string, number>} */
  const maxSeqByDevH = {};
  let cursor = undefined;
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (!parsed) continue;
      maxSeqByDevH[parsed.devH] = Math.max(maxSeqByDevH[parsed.devH] ?? -1, parsed.seq);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  for (const [devH, maxSeq] of Object.entries(maxSeqByDevH)) {
    if (maxSeq < 0) continue;
    const trusted = snap.trusted_heads?.[devH];
    if (!trusted || trusted.seq !== maxSeq) {
      throw new Error(`Snapshot omits or misstates live log head for ${devH}`);
    }
    const envelope = await readEnvelopeAtSeq(ctx, devH, maxSeq);
    if (!envelope) {
      throw new Error(`Snapshot trusted segment missing at ${devH} seq ${maxSeq}`);
    }
    const digest = layoutSegmentEnvelopeDigest(envelope);
    if (digest !== trusted.digest) {
      throw new Error(`Snapshot trusted digest mismatch at ${devH} seq ${maxSeq}`);
    }
  }
}

/** @param {import('./storage-manifest.mjs').StorageManifest} manifest @param {StorageSnapshotRecord} snap */
export function assertSnapshotCoversManifestKnowledge(manifest, snap) {
  /** @type {Set<string>} */
  const required = new Set([
    ...Object.keys(manifest.trusted_heads ?? {}),
    ...Object.keys(normalizeVectorSyncCursor(manifest.compacted_through).v ?? {}),
  ]);
  for (const devH of required) {
    const floor = Number(normalizeVectorSyncCursor(manifest.compacted_through).v?.[devH] ?? -1);
    const head = snap.trusted_heads?.[devH];
    if (!head) {
      throw new Error(`Snapshot omits manifest-known device ${devH}`);
    }
    if (Number.isFinite(floor) && floor >= 0 && head.seq < floor) {
      throw new Error(`Snapshot head for ${devH} is below manifest compacted floor`);
    }
  }
}

async function verifyOrphanSnapshotAdoptable(ctx, snap) {
  await verifySnapshotTrustedHeads(ctx, snap);
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/`;
  /** @type {Record<string, number>} */
  const maxSeqByDevH = {};
  let cursor = undefined;
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (!parsed) continue;
      maxSeqByDevH[parsed.devH] = Math.max(maxSeqByDevH[parsed.devH] ?? -1, parsed.seq);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  for (const [devH, trusted] of Object.entries(snap.trusted_heads ?? {})) {
    if (!trusted) continue;
    const live = maxSeqByDevH[devH];
    if (live !== undefined && trusted.seq > live) {
      throw new Error(`Orphan snapshot head ahead of live log for ${devH}`);
    }
  }
}

export async function verifySnapshotTrustedHeads(ctx, snap, options = {}) {
  for (const [devH, trusted] of Object.entries(snap.trusted_heads ?? {})) {
    if (!trusted) continue;
    await verifyDeviceLogThroughSeq(
      ctx,
      devH,
      { seq: trusted.seq, digest: trusted.digest },
      (seq) => readEnvelopeAtSeq(ctx, devH, seq),
      trusted.seq,
    );
    const envelope = await readEnvelopeAtSeq(ctx, devH, trusted.seq);
    if (!envelope) {
      throw new Error(`Snapshot trusted segment missing at ${devH} seq ${trusted.seq}`);
    }
    const digest = layoutSegmentEnvelopeDigest(envelope);
    if (digest !== trusted.digest) {
      throw new Error(`Snapshot trusted digest mismatch at ${devH} seq ${trusted.seq}`);
    }
  }
  if (options.requireFullLogCoverage) {
    await assertSnapshotCoversLiveLogHeads(ctx, snap);
  }
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
export function stateNeedsSnapshotBootstrap(state) {
  const heads = Object.values(state.trustedHeads ?? {});
  if (heads.some(Boolean)) return false;
  const cursor = normalizeVectorSyncCursor(state.vectorCursor);
  return Object.keys(cursor.v ?? {}).length === 0;
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {number[]} epochs
 */
export function resolveBootstrapSnapshotEpoch(manifest, epochs) {
  if (!epochs.length) return null;
  if (manifest.latest_snapshot_epoch >= 0) {
    if (!epochs.includes(manifest.latest_snapshot_epoch)) {
      throw new Error(
        `Missing snapshot object for manifest latest_snapshot_epoch=${manifest.latest_snapshot_epoch}`,
      );
    }
    return manifest.latest_snapshot_epoch;
  }
  return epochs[epochs.length - 1];
}

export async function bootstrapLocalStateFromLatestSnapshot(ctx, state) {
  if (!stateNeedsSnapshotBootstrap(state)) return null;
  const manifest = await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, state);
  const epochs = await listSnapshotEpochs(ctx);
  const epoch = resolveBootstrapSnapshotEpoch(manifest, epochs);
  if (epoch === null) return null;
  const snap = await loadStorageSnapshot(ctx, epoch);
  if (!snap) {
    throw new Error(`Snapshot epoch ${epoch} listed but unreadable`);
  }
  await verifySnapshotTrustedHeads(ctx, snap);
  assertSnapshotCoversManifestKnowledge(manifest, snap);
  for (const [devH, head] of Object.entries(snap.trusted_heads ?? {})) {
    if (head) commitTrustedHeadAdvance(state, devH, head);
  }
  const bootCursor = normalizeVectorSyncCursor(snap.compacted_through);
  for (const [devH, head] of Object.entries(snap.trusted_heads ?? {})) {
    if (head) advanceVectorCursorDevH(bootCursor, devH, head.seq);
  }
  state.vectorCursor = bootCursor;
  state.snapshotCompactedThrough = normalizeVectorSyncCursor(snap.compacted_through);
  state.appliedSnapshotEpoch = epoch;
  state.pendingBootstrapReplica = sanitizeSyncReplicaForPersist(snap.replica);
  state.bootstrapReplicaPendingAck = true;
  return snap;
}

/**
 * Adopt verified orphan snapshots after a crash between snap write and manifest update.
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
export async function adoptVerifiedOrphanSnapshots(ctx) {
  const manifest = await loadStorageManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
  const epochs = await listSnapshotEpochs(ctx);
  /** @type {StorageSnapshotRecord | null} */
  let bestSnap = null;
  let bestEpoch = manifest.latest_snapshot_epoch;
  for (const epoch of epochs) {
    if (epoch <= manifest.latest_snapshot_epoch) continue;
    const snap = await loadStorageSnapshot(ctx, epoch);
    if (!snap) continue;
    await verifyOrphanSnapshotAdoptable(ctx, snap);
    if (epoch > bestEpoch) {
      bestEpoch = epoch;
      bestSnap = snap;
    }
  }
  if (!bestSnap) return manifest;
  return updateStorageManifest(
    {
      adapter: ctx.adapter,
      dek: ctx.dek,
      layoutPrefix: ctx.layoutPrefix,
      ownerDevH: ctx.selfDevH,
      settleMs: 0,
    },
    (m) => {
      m.latest_snapshot_epoch = bestEpoch;
      m.compacted_through = maxVectorSyncCursor(m.compacted_through, bestSnap.compacted_through);
      m.trusted_heads = mergeTrustedHeadsMonotonic(m.trusted_heads, bestSnap.trusted_heads);
      return m;
    },
  );
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {Record<string, unknown>} replica
 * @param {Object} [options]
 * @param {number} [options.settleMs]
 */
export async function compactObjectStoreReplica(ctx, state, replica, options = {}) {
  await adoptVerifiedOrphanSnapshots(ctx);
  const manifest = await loadStorageManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
  const epochs = await listSnapshotEpochs(ctx);
  const maxListedEpoch = epochs.length ? Math.max(...epochs) : -1;
  const nextEpoch = Math.max(manifest.latest_snapshot_epoch, maxListedEpoch) + 1;
  /** @type {Record<string, { seq: number, digest: string }>} */
  const trustedHeads = {};
  for (const [devH, head] of Object.entries(state.trustedHeads ?? {})) {
    if (head) trustedHeads[devH] = { seq: head.seq, digest: head.digest };
  }
  const compactedThrough = normalizeVectorSyncCursor(state.vectorCursor);
  for (const [devH, head] of Object.entries(trustedHeads)) {
    advanceVectorCursorDevH(compactedThrough, devH, head.seq);
  }

  const sanitizedReplica = sanitizeSyncReplicaForPersist(replica);
  /** @type {StorageSnapshotRecord} */
  const snapRecord = {
    format: SNAPSHOT_FORMAT,
    epoch: nextEpoch,
    created_at: new Date().toISOString(),
    compacted_through: compactedThrough,
    trusted_heads: trustedHeads,
    replica: sanitizedReplica,
  };

  const snapKey = snapEncRelativePath(ctx.layoutPrefix, nextEpoch);
  try {
    await storageConditionalCreate({
      adapter: ctx.adapter,
      dek: ctx.dek,
      objectKey: snapKey,
      plaintext: wrapStorageSnapshotPlain(snapRecord),
    });
  } catch (err) {
    if (!(err instanceof PreconditionFailedError)) throw err;
    const existing = await loadStorageSnapshot(ctx, nextEpoch);
    if (!existing) throw err;
    await verifyOrphanSnapshotAdoptable(ctx, existing);
  }

  if (options.testHookAfterSnapshotWrite) {
    await options.testHookAfterSnapshotWrite({ epoch: nextEpoch, snapRecord });
  }

  await updateStorageManifest(
    {
      adapter: ctx.adapter,
      dek: ctx.dek,
      layoutPrefix: ctx.layoutPrefix,
      ownerDevH: ctx.selfDevH,
      settleMs: options.settleMs,
    },
    (manifest) => {
      manifest.latest_snapshot_epoch = Math.max(manifest.latest_snapshot_epoch, nextEpoch);
      manifest.compacted_through = maxVectorSyncCursor(manifest.compacted_through, compactedThrough);
      manifest.trusted_heads = mergeTrustedHeadsMonotonic(manifest.trusted_heads, trustedHeads);
      upsertManifestDeviceAck(
        manifest,
        ctx.selfDevH,
        state.trustedHeads[ctx.selfDevH]?.seq ?? -1,
        state.vectorCursor,
      );
      return manifest;
    },
  );

  return { epoch: nextEpoch, compacted_through: compactedThrough };
}

/** @param {string} key */
function parseLogSegmentKey(key) {
  const match = /\/log\/([0-9A-HJKMNP-TV-Z]{26})\/(\d{12})\.enc$/i.exec(key);
  if (!match) return null;
  return { devH: match[1].toUpperCase(), seq: Number(match[2]) };
}

/**
 * Delete log segments at or below manifest.compacted_through (per devH).
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage-manifest.mjs').StorageManifest} [manifest]
 */
/** @param {import('./storage-manifest.mjs').StorageManifest} manifest @param {string} devH */
export function gcSafeSeqFloorForDevH(manifest, devH) {
  const canon = devH.toUpperCase();
  const compactFloor = Number(normalizeVectorSyncCursor(manifest.compacted_through).v?.[canon] ?? -1);
  if (!Number.isFinite(compactFloor) || compactFloor < 0) return -1;
  const headSeq = Number(manifest.trusted_heads?.[canon]?.seq ?? compactFloor);
  if (!Number.isFinite(headSeq) || headSeq < 0) return -1;
  const participants = manifest.sync_participants ?? [];
  if (!manifest.devices.length && participants.length) return -1;
  for (const participant of participants) {
    if (!manifest.devices.some((row) => row.devH === participant)) return -1;
  }
  let minAck = Number.POSITIVE_INFINITY;
  for (const row of manifest.devices) {
    const ack = row.acknowledged_cursor?.v?.[canon];
    if (ack === undefined && row.devH !== canon) return -1;
    const ackSeq = ack !== undefined ? Number(ack) : row.devH === canon ? row.acknowledged_seq : -1;
    if (!Number.isFinite(ackSeq) || ackSeq < 0) return -1;
    minAck = Math.min(minAck, ackSeq);
  }
  if (!manifest.devices.length) return -1;
  if (!Number.isFinite(minAck) || minAck < compactFloor) return -1;
  const deleteThrough = Math.min(compactFloor, headSeq - 1);
  if (deleteThrough < 0) return -1;
  return deleteThrough;
}

export async function gcLogSegmentsCoveredByCompaction(ctx, manifest) {
  const m = manifest ?? (await loadStorageManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix));
  const prefix = `${layoutRootPath(ctx.layoutPrefix)}/log/`;
  let cursor = undefined;
  /** @type {string[]} */
  const toDelete = [];
  for (;;) {
    const page = await ctx.adapter.list(prefix, { limit: 500, cursor });
    for (const row of page.objects) {
      const parsed = parseLogSegmentKey(row.key);
      if (!parsed) continue;
      const threshold = gcSafeSeqFloorForDevH(m, parsed.devH);
      const headSeq = Number(m.trusted_heads?.[parsed.devH]?.seq ?? -1);
      if (threshold >= 0 && parsed.seq <= threshold && parsed.seq !== headSeq) toDelete.push(row.key);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  for (const key of toDelete) {
    await ctx.adapter.delete(key);
  }
  return { deleted: toDelete.length, keys: toDelete };
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
export async function recordManifestAcknowledgement(ctx, state) {
  const selfHead = state.trustedHeads[ctx.selfDevH]?.seq ?? -1;
  if (state.pendingBootstrapReplica || state.bootstrapReplicaPendingAck) {
    return;
  }
  await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, state);
  const ackCursor = normalizeVectorSyncCursor(state.vectorCursor);
  await updateStorageManifest(
    {
      adapter: ctx.adapter,
      dek: ctx.dek,
      layoutPrefix: ctx.layoutPrefix,
      ownerDevH: ctx.selfDevH,
      settleMs: LEASE_DEFAULT_SETTLE_MS,
    },
    (manifest) => {
      upsertManifestDeviceAck(manifest, ctx.selfDevH, selfHead, ackCursor);
      return manifest;
    },
  );
}

/** Clear bootstrap pending flag after replica was delivered to the client. */
export function clearPendingBootstrapReplica(state) {
  delete state.pendingBootstrapReplica;
  state.bootstrapReplicaPendingAck = false;
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
export async function confirmObjectStorePullDelivery(ctx) {
  const state = ctx.localState.load();
  if (state.pendingBootstrapReplica || state.bootstrapReplicaPendingAck) {
    clearPendingBootstrapReplica(state);
    await ctx.localState.save(state);
  }
  await recordManifestAcknowledgement(ctx, state);
}

export { createEmptyObjectStoreLocalSyncState };
