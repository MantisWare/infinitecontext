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
import { applyPendingPullDeliveryApply } from "../object-store-pull-delivery.mjs";
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
  registerManifestSyncParticipant,
  updateStorageManifest,
  upsertManifestDeviceAck,
  wrapStorageManifestPlain,
} from "./storage-manifest.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import {
  loadDeviceSyncAck,
  trustedDeviceAckSeqForLog,
  writeDeviceSyncAckFromState,
} from "./storage-device-sync-ack.mjs";
import { LEASE_DEFAULT_SETTLE_MS } from "./lease-lock.mjs";
import { isInjectedTestHookActive } from "./test-hooks.mjs";
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
  const { storageAdapterIgnoresSnapshotObjects } = await import("./storage-adapter-policy.mjs");
  if (storageAdapterIgnoresSnapshotObjects(ctx.adapter)) {
    return [];
  }
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

/**
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {StorageSnapshotRecord} snap
 * @param {{ localTrustedHeads?: Record<string, { seq: number, digest: string }> }} [options]
 */
export function assertSnapshotCoversManifestKnowledge(manifest, snap, options = {}) {
  /** @type {Set<string>} */
  const required = new Set([
    ...Object.keys(snap.trusted_heads ?? {}),
    ...Object.keys(normalizeVectorSyncCursor(snap.compacted_through).v ?? {}),
  ]);
  for (const devH of required) {
    const head = snap.trusted_heads?.[devH];
    if (!head || head.seq < 0) continue;
    const floor = Number(normalizeVectorSyncCursor(manifest.compacted_through).v?.[devH] ?? -1);
    if (Number.isFinite(floor) && floor >= 0 && head.seq < floor) {
      throw new Error(`Snapshot head for ${devH} is below manifest compacted floor`);
    }
  }
  void options;
}

/** @param {import('./storage-manifest.mjs').StorageManifest} manifest @param {import('../object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state */
export function isCompactionCaughtUpWithManifest(manifest, state) {
  for (const [devH, manifestHead] of Object.entries(manifest.trusted_heads ?? {})) {
    if (!manifestHead || manifestHead.seq < 0) continue;
    const local = state.trustedHeads?.[devH];
    if (!local || local.seq < 0 || local.seq < manifestHead.seq) return false;
    if (local.seq === manifestHead.seq && local.digest !== manifestHead.digest) return false;
  }
  return true;
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

export async function assertSnapshotHeadsMatchLiveLogs(ctx, snap) {
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
    if (!trusted || trusted.seq < 0) {
      const live = maxSeqByDevH[devH];
      if (live !== undefined && live >= 0) {
        throw new Error(`Snapshot claims inactive head for ${devH} but live log exists through seq ${live}`);
      }
      continue;
    }
    const live = maxSeqByDevH[devH];
    if (live !== undefined && trusted.seq > live) {
      throw new Error(`Snapshot head ahead of live log for ${devH}`);
    }
  }
}

export async function verifySnapshotTrustedHeads(ctx, snap, options = {}) {
  await assertSnapshotHeadsMatchLiveLogs(ctx, snap);
  for (const [devH, trusted] of Object.entries(snap.trusted_heads ?? {})) {
    if (!trusted || trusted.seq < 0) continue;
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

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {import('../object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
async function assertManifestLogDevicesCoveredBySnapshotOrChain(ctx, manifest, snap) {
  for (const [devH, head] of Object.entries(manifest.trusted_heads ?? {})) {
    if (!head || head.seq < 0) continue;
    const snapHead = snap.trusted_heads?.[devH];
    if (snapHead && snapHead.seq >= 0) continue;
    await verifyDeviceLogThroughSeq(
      ctx,
      devH,
      null,
      (seq) => readEnvelopeAtSeq(ctx, devH, seq),
      head.seq,
    );
    const envelope = await readEnvelopeAtSeq(ctx, devH, head.seq);
    if (!envelope || layoutSegmentEnvelopeDigest(envelope) !== head.digest) {
      throw new Error(`Device ${devH} absent from snapshot and live log does not verify`);
    }
  }
}

export async function pickVerifiedBootstrapSnapshot(ctx, manifest, state) {
  const { storageAdapterIgnoresSnapshotObjects } = await import("./storage-adapter-policy.mjs");
  if (storageAdapterIgnoresSnapshotObjects(ctx.adapter)) {
    return null;
  }
  const epochs = await listSnapshotEpochs(ctx);
  if (!epochs.length) return null;
  const sorted = [...epochs].sort((a, b) => b - a);
  /** @type {string | null} */
  let lastError = null;
  for (const epoch of sorted) {
    const snap = await loadStorageSnapshot(ctx, epoch);
    if (!snap) continue;
    try {
      await verifySnapshotTrustedHeads(ctx, snap);
      assertSnapshotCoversManifestKnowledge(manifest, snap, { localTrustedHeads: state.trustedHeads });
      await assertManifestLogDevicesCoveredBySnapshotOrChain(ctx, manifest, snap);
      return { epoch, snap };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (lastError) {
    throw new Error(`No verified snapshot satisfies manifest compaction floor (${lastError})`);
  }
  return null;
}

export async function bootstrapLocalStateFromLatestSnapshot(ctx, state) {
  if (!stateNeedsSnapshotBootstrap(state)) return null;
  const manifest = await loadStorageManifestForSync(ctx.adapter, ctx.dek, ctx.layoutPrefix, state);
  const picked = await pickVerifiedBootstrapSnapshot(ctx, manifest, state);
  if (!picked) return null;
  const { epoch, snap } = picked;
  for (const [devH, head] of Object.entries(snap.trusted_heads ?? {})) {
    if (head && head.seq >= 0) commitTrustedHeadAdvance(state, devH, head);
  }
  const bootCursor = normalizeVectorSyncCursor(snap.compacted_through);
  for (const [devH, head] of Object.entries(snap.trusted_heads ?? {})) {
    if (head && head.seq >= 0) advanceVectorCursorDevH(bootCursor, devH, head.seq);
  }
  state.vectorCursor = maxVectorSyncCursor(state.vectorCursor, bootCursor);
  state.snapshotCompactedThrough = normalizeVectorSyncCursor(snap.compacted_through);
  state.appliedSnapshotEpoch = epoch;
  state.verifiedManifestGeneration = manifest.manifest_generation;
  state.pendingBootstrapReplica = sanitizeSyncReplicaForPersist(snap.replica);
  state.bootstrapReplicaPendingAck = true;
  return snap;
}

/**
 * Adopt verified orphan snapshots after a crash between snap write and manifest update.
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
export async function adoptVerifiedOrphanSnapshots(ctx) {
  const { isObjectStoreCompactionEnabled } = await import("./storage-adapter-policy.mjs");
  if (!isObjectStoreCompactionEnabled(ctx.adapter)) {
    return loadStorageManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
  }
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
  const { isObjectStoreCompactionEnabled } = await import("./storage-adapter-policy.mjs");
  if (!isObjectStoreCompactionEnabled(ctx.adapter)) {
    return { skipped: true, reason: "compaction_disabled" };
  }
  await adoptVerifiedOrphanSnapshots(ctx);
  const manifest = await loadStorageManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
  if (!isCompactionCaughtUpWithManifest(manifest, state)) {
    return { skipped: true, reason: "lagging_compactor" };
  }
  const epochs = await listSnapshotEpochs(ctx);
  const maxListedEpoch = epochs.length ? Math.max(...epochs) : -1;
  const nextEpoch = Math.max(manifest.latest_snapshot_epoch, maxListedEpoch) + 1;
  /** @type {Record<string, { seq: number, digest: string }>} */
  const trustedHeads = {};
  for (const [devH, head] of Object.entries(
    mergeTrustedHeadsMonotonic(manifest.trusted_heads ?? {}, state.trustedHeads ?? {}),
  )) {
    if (head && head.seq >= 0) trustedHeads[devH] = head;
  }
  const compactedThrough = normalizeVectorSyncCursor(state.vectorCursor);
  for (const [devH, head] of Object.entries(trustedHeads)) {
    advanceVectorCursorDevH(compactedThrough, devH, head.seq);
  }

  const sanitizedReplica = sanitizeSyncReplicaForPersist(replica);
  assertSnapshotCoversManifestKnowledge(manifest, {
    format: SNAPSHOT_FORMAT,
    epoch: nextEpoch,
    created_at: new Date().toISOString(),
    compacted_through: compactedThrough,
    trusted_heads: trustedHeads,
    replica: sanitizedReplica,
  });
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

  if (isInjectedTestHookActive(options, "testHookAfterSnapshotWrite")) {
    await options.testHookAfterSnapshotWrite({ epoch: nextEpoch, snapRecord });
  }

  const updatedManifest = await updateStorageManifest(
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

  state.appliedSnapshotEpoch = nextEpoch;
  state.verifiedManifestGeneration = updatedManifest.manifest_generation;
  state.snapshotCompactedThrough = normalizeVectorSyncCursor(compactedThrough);
  await ctx.localState.save(state);
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
/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {string} devH
 */
export async function gcSafeSeqFloorForDevH(ctx, manifest, devH) {
  const canon = devH.toUpperCase();
  const compactFloor = Number(normalizeVectorSyncCursor(manifest.compacted_through).v?.[canon] ?? -1);
  if (!Number.isFinite(compactFloor) || compactFloor < 0) return -1;
  const trustedHead = manifest.trusted_heads?.[canon];
  if (!trustedHead) return -1;
  const headEnvelope = await readEnvelopeAtSeq(ctx, canon, trustedHead.seq);
  if (!headEnvelope || layoutSegmentEnvelopeDigest(headEnvelope) !== trustedHead.digest) {
    return -1;
  }
  const headSeq = trustedHead.seq;
  /** @type {Set<string>} */
  const participantSet = new Set([
    ...(manifest.sync_participants ?? []),
    ...manifest.devices.map((row) => row.devH),
  ]);
  if (!participantSet.size) return -1;
  let minAck = Number.POSITIVE_INFINITY;
  for (const participant of participantSet) {
    const row = manifest.devices.find((d) => d.devH === participant);
    const deviceHead = manifest.trusted_heads?.[participant];
    if (deviceHead && Number.isFinite(deviceHead.seq) && deviceHead.seq >= 0) {
      const env = await readEnvelopeAtSeq(ctx, participant, deviceHead.seq);
      if (!env || layoutSegmentEnvelopeDigest(env) !== deviceHead.digest) return -1;
    }
    const deviceAck = await loadDeviceSyncAck(ctx, participant);
    const ackForCanon = trustedDeviceAckSeqForLog(deviceAck, participant, canon, manifest);
    if (!Number.isFinite(ackForCanon) || ackForCanon < 0) return -1;
    if (row && ackForCanon > headSeq) return -1;
    minAck = Math.min(minAck, ackForCanon);
  }
  if (!Number.isFinite(minAck) || minAck < compactFloor) return -1;
  const deleteThrough = Math.min(compactFloor, headSeq - 1, minAck);
  if (deleteThrough < 0) return -1;
  return deleteThrough;
}

export async function gcLogSegmentsCoveredByCompaction(ctx, manifest) {
  const { isObjectStoreLogGcEnabled } = await import("./storage-adapter-policy.mjs");
  if (!isObjectStoreLogGcEnabled(ctx.adapter)) {
    return { deleted: 0, keys: [], gcDisabled: true };
  }
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
      const threshold = await gcSafeSeqFloorForDevH(ctx, m, parsed.devH);
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
  state.pendingBootstrapReplica = null;
  state.bootstrapReplicaPendingAck = false;
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
export async function confirmObjectStorePullDelivery(ctx) {
  const { withCasConditionalCreateFriendlyError } = await import("./cas-conditional-user-error.mjs");
  await withCasConditionalCreateFriendlyError(async () => {
    let state = ctx.localState.load();
    if (applyPendingPullDeliveryApply(state)) {
      state.pendingPullDeliveryApply = null;
    }
    if (state.pendingBootstrapReplica || state.bootstrapReplicaPendingAck) {
      clearPendingBootstrapReplica(state);
    }
    await ctx.localState.save(state);
    await recordManifestAcknowledgement(ctx, state);
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
    const fresh = ctx.localState.load();
    await writeDeviceSyncAckFromState(
      {
        adapter: ctx.adapter,
        dek: ctx.dek,
        layoutPrefix: ctx.layoutPrefix,
        ownerDevH: ctx.selfDevH,
        deviceUuid: ctx.deviceUuid,
      },
      fresh,
    );
  });
}

export { createEmptyObjectStoreLocalSyncState };
