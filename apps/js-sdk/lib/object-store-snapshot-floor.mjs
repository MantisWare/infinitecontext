import { maxVectorSyncCursor, normalizeVectorSyncCursor } from "./sync-cursor.mjs";
import {
  checkTrustedHeadAdvance,
  commitTrustedHeadAdvance,
  ObjectStoreLogForkError,
  ObjectStoreLogRollbackError,
} from "./object-store-local-sync-state.mjs";
import { verifyDeviceLogThroughSeq } from "./object-store-chain-verify.mjs";
import {
  assertSnapshotHeadsMatchLiveLogs,
  loadStorageSnapshot,
} from "./storage/storage-compaction.mjs";
import { snapEncRelativePath } from "./storage/layout.mjs";
import { layoutSegmentEnvelopeDigest } from "./storage/layout.mjs";
import { decryptVaultStorageObjectPlaintext } from "./storage/storage-object-move.mjs";
import { sanitizeSyncReplicaForPersist } from "./sync-replica-state.mjs";
import { effectiveVectorCursorForPull } from "./object-store-pull-delivery.mjs";

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 * @param {string} devH
 */
export function verifiedSnapshotFloorForDevH(state, manifest, devH) {
  const canon = devH.toUpperCase();
  if (!Number.isFinite(state.appliedSnapshotEpoch) || state.appliedSnapshotEpoch < 0) return -1;
  if (state.appliedSnapshotEpoch !== manifest.latest_snapshot_epoch) return -1;
  if (state.verifiedManifestGeneration !== manifest.manifest_generation) return -1;
  const floor = Number(normalizeVectorSyncCursor(state.snapshotCompactedThrough).v?.[canon] ?? -1);
  return Number.isFinite(floor) && floor >= 0 ? floor : -1;
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
/**
 * When manifest generation advances without a new snapshot epoch or tighter compacted floor,
 * keep the prior verified snapshot floor binding.
 *
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
export function refreshVerifiedSnapshotGenerationBinding(state, manifest) {
  if (!Number.isFinite(state.verifiedManifestGeneration)) return false;
  if (state.appliedSnapshotEpoch !== manifest.latest_snapshot_epoch) return false;
  const localCompacted = normalizeVectorSyncCursor(state.snapshotCompactedThrough ?? 0);
  const manifestCompacted = normalizeVectorSyncCursor(manifest.compacted_through ?? 0);
  for (const [devH, floorRaw] of Object.entries(manifestCompacted.v ?? {})) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor) || floor < 0) continue;
    const localFloor = Number(localCompacted.v?.[devH.toUpperCase()] ?? localCompacted.v?.[devH] ?? -1);
    if (localFloor < floor) return false;
  }
  if (manifest.manifest_generation <= state.verifiedManifestGeneration) return false;
  state.verifiedManifestGeneration = manifest.manifest_generation;
  return true;
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
export function vectorCursorBelowManifestFloor(state, manifest) {
  const cursor = effectiveVectorCursorForPull(state);
  const compacted = normalizeVectorSyncCursor(manifest.compacted_through).v ?? {};
  for (const [devH, floorRaw] of Object.entries(compacted)) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor) || floor < 0) continue;
    const canon = devH.toUpperCase();
    const cur = Number(cursor.v?.[canon] ?? -1);
    if (cur < floor) return true;
  }
  return false;
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
export function stateNeedsSnapshotFloorCatchUp(state, manifest) {
  if (state.bootstrapReplicaPendingAck && state.pendingBootstrapReplica) return false;
  if (manifest.latest_snapshot_epoch < 0) return false;
  if (!vectorCursorBelowManifestFloor(state, manifest)) return false;
  return Object.values(state.trustedHeads ?? {}).some((head) => head && head.seq >= 0);
}

export function manifestNeedsVerifiedSnapshotFloorAdoption(state, manifest) {
  if (manifest.latest_snapshot_epoch < 0) return false;
  const compacted = normalizeVectorSyncCursor(manifest.compacted_through).v ?? {};
  for (const [devH, floorRaw] of Object.entries(compacted)) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor) || floor < 0) continue;
    if (verifiedSnapshotFloorForDevH(state, manifest, devH) < floor) return true;
  }
  return false;
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 * @param {import('./storage/storage-compaction.mjs').StorageSnapshotRecord} snap
 */
export async function verifyCoveringSnapshotBinding(ctx, manifest, snap) {
  if (manifest.latest_snapshot_epoch < 0) {
    throw new ObjectStoreLogRollbackError("Manifest has no latest_snapshot_epoch for GC floor");
  }
  if (snap.epoch !== manifest.latest_snapshot_epoch) {
    throw new ObjectStoreLogRollbackError(
      `Snapshot epoch ${snap.epoch} does not match manifest latest_snapshot_epoch ${manifest.latest_snapshot_epoch}`,
    );
  }
  const key = snapEncRelativePath(ctx.layoutPrefix, snap.epoch);
  const row = await ctx.adapter.get(key);
  if (!row?.body) {
    throw new ObjectStoreLogRollbackError(`Missing snapshot object for epoch ${snap.epoch}`);
  }
  decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
  const merged = maxVectorSyncCursor(snap.compacted_through, manifest.compacted_through);
  if (JSON.stringify(merged) !== JSON.stringify(normalizeVectorSyncCursor(manifest.compacted_through))) {
    throw new ObjectStoreLogRollbackError("Snapshot compacted_through below manifest compacted_through");
  }
  for (const [devH, floorRaw] of Object.entries(normalizeVectorSyncCursor(manifest.compacted_through).v ?? {})) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor) || floor < 0) continue;
    const head = snap.trusted_heads?.[devH];
    if (!head || head.seq < floor) {
      throw new ObjectStoreLogRollbackError(`Snapshot does not cover manifest GC floor for ${devH}`);
    }
    const snapFloor = Number(normalizeVectorSyncCursor(snap.compacted_through).v?.[devH] ?? -1);
    if (!Number.isFinite(snapFloor) || snapFloor < floor) {
      throw new ObjectStoreLogRollbackError(`Snapshot compacted floor below manifest for ${devH}`);
    }
  }
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 * @param {import('./storage/storage-compaction.mjs').StorageSnapshotRecord} snap
 * @param {(devH: string, seq: number) => Promise<import('./ic-crypto.mjs').AeadEnvelope | null>} readEnvelopeAtSeq
 */
export async function verifySnapshotTrustedHeadsForManifestFloor(ctx, state, manifest, snap, readEnvelopeAtSeq) {
  await verifyCoveringSnapshotBinding(ctx, manifest, snap);
  await assertSnapshotHeadsMatchLiveLogs(ctx, snap);
  for (const [devH, floorRaw] of Object.entries(normalizeVectorSyncCursor(manifest.compacted_through).v ?? {})) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor) || floor < 0) continue;
    const snapHead = snap.trusted_heads?.[devH];
    if (!snapHead || snapHead.seq < floor) {
      throw new ObjectStoreLogRollbackError(`Snapshot missing trusted head through floor for ${devH}`);
    }
    const local = state.trustedHeads[devH];
    if (local && local.seq >= 0) {
      if (local.seq === snapHead.seq) {
        checkTrustedHeadAdvance(local, snapHead);
      } else if (local.seq < snapHead.seq) {
        if (local.seq >= floor) {
          await verifyDeviceLogThroughSeq(
            ctx,
            devH,
            local,
            (seq) => readEnvelopeAtSeq(devH, seq),
            snapHead.seq,
          );
        }
        const env = await readEnvelopeAtSeq(devH, snapHead.seq);
        if (!env || layoutSegmentEnvelopeDigest(env) !== snapHead.digest) {
          throw new ObjectStoreLogForkError(`Snapshot head digest mismatch for ${devH} at seq ${snapHead.seq}`);
        }
      } else {
        const localEnv = await readEnvelopeAtSeq(devH, local.seq);
        if (!localEnv || layoutSegmentEnvelopeDigest(localEnv) !== local.digest) {
          throw new ObjectStoreLogForkError(`Local trusted head missing on storage for ${devH} at seq ${local.seq}`);
        }
        if (local.seq > snapHead.seq && snapHead.seq >= floor) {
          const snapEnv = await readEnvelopeAtSeq(devH, snapHead.seq);
          if (!snapEnv || layoutSegmentEnvelopeDigest(snapEnv) !== snapHead.digest) {
            throw new ObjectStoreLogForkError(`Snapshot head digest mismatch for ${devH} at seq ${snapHead.seq}`);
          }
        }
      }
    } else {
      const tipEnv = await readEnvelopeAtSeq(devH, snapHead.seq);
      if (!tipEnv) {
        throw new ObjectStoreLogRollbackError(
          `Live log missing snapshot trusted tip for ${devH} at seq ${snapHead.seq}`,
        );
      }
      if (layoutSegmentEnvelopeDigest(tipEnv) !== snapHead.digest) {
        throw new ObjectStoreLogForkError(`Snapshot trusted digest mismatch at ${devH} seq ${snapHead.seq}`);
      }
    }
  }
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-compaction.mjs').StorageSnapshotRecord} snap
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 */
export function anchorTrustedHeadsFromCoveringSnapshot(state, snap, manifest) {
  for (const [devH, floorRaw] of Object.entries(normalizeVectorSyncCursor(manifest.compacted_through).v ?? {})) {
    const floor = Number(floorRaw);
    if (!Number.isFinite(floor) || floor < 0) continue;
    const snapHead = snap.trusted_heads?.[devH];
    if (!snapHead || snapHead.seq < floor) {
      throw new ObjectStoreLogRollbackError(`Snapshot missing trusted head through floor for ${devH}`);
    }
    const local = state.trustedHeads[devH];
    if (!local || local.seq < snapHead.seq) {
      commitTrustedHeadAdvance(state, devH, snapHead);
    } else if (local.seq === snapHead.seq) {
      checkTrustedHeadAdvance(local, snapHead);
    }
  }
  for (const [remoteDevH, head] of Object.entries(snap.trusted_heads ?? {})) {
    if (!head || head.seq < 0) continue;
    const remoteFloor = Number(
      normalizeVectorSyncCursor(manifest.compacted_through).v?.[remoteDevH] ?? -1,
    );
    if (!Number.isFinite(remoteFloor) || remoteFloor < 0) continue;
    const prev = state.trustedHeads[remoteDevH];
    if (!prev) {
      commitTrustedHeadAdvance(state, remoteDevH, head);
    } else if (prev.seq === head.seq) {
      checkTrustedHeadAdvance(prev, head);
    } else if (prev.seq < head.seq) {
      commitTrustedHeadAdvance(state, remoteDevH, head);
    }
  }
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 * @param {(devH: string, seq: number) => Promise<import('./ic-crypto.mjs').AeadEnvelope | null>} readEnvelopeAtSeq
 * @returns {Promise<boolean>} true when state was updated
 */
/**
 * Device pushed (or pulled partially) while vector cursor is below manifest compacted floor:
 * deliver snapshot bootstrap + defer cursor advance until confirm (invariant 1).
 *
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {import('./storage/storage-manifest.mjs').StorageManifest} manifest
 * @param {(devH: string, seq: number) => Promise<import('./ic-crypto.mjs').AeadEnvelope | null>} readEnvelopeAtSeq
 */
export async function bootstrapVerifiedSnapshotFloorCatchUp(ctx, state, manifest, readEnvelopeAtSeq) {
  if (!stateNeedsSnapshotFloorCatchUp(state, manifest)) return false;
  if (manifest.latest_snapshot_epoch < 0) {
    throw new ObjectStoreLogRollbackError("Manifest compacted_through set without latest_snapshot_epoch");
  }
  const snap = await loadStorageSnapshot(ctx, manifest.latest_snapshot_epoch);
  if (!snap) {
    throw new ObjectStoreLogRollbackError(
      `Missing snapshot epoch ${manifest.latest_snapshot_epoch} required for verified GC floor`,
    );
  }
  await verifySnapshotTrustedHeadsForManifestFloor(ctx, state, manifest, snap, readEnvelopeAtSeq);
  anchorTrustedHeadsFromCoveringSnapshot(state, snap, manifest);
  state.appliedSnapshotEpoch = snap.epoch;
  state.verifiedManifestGeneration = manifest.manifest_generation;
  state.snapshotCompactedThrough = maxVectorSyncCursor(
    normalizeVectorSyncCursor(state.snapshotCompactedThrough),
    normalizeVectorSyncCursor(manifest.compacted_through),
  );
  state.vectorCursor = normalizeVectorSyncCursor(manifest.compacted_through);
  state.pendingBootstrapReplica = sanitizeSyncReplicaForPersist(snap.replica);
  state.bootstrapReplicaPendingAck = true;
  return true;
}

export async function ensureManifestVerifiedSnapshotFloors(ctx, state, manifest, readEnvelopeAtSeq) {
  if (vectorCursorBelowManifestFloor(state, manifest)) return false;
  if (!manifestNeedsVerifiedSnapshotFloorAdoption(state, manifest)) return false;
  if (manifest.latest_snapshot_epoch < 0) {
    throw new ObjectStoreLogRollbackError("Manifest compacted_through set without latest_snapshot_epoch");
  }
  const snap = await loadStorageSnapshot(ctx, manifest.latest_snapshot_epoch);
  if (!snap) {
    throw new ObjectStoreLogRollbackError(
      `Missing snapshot epoch ${manifest.latest_snapshot_epoch} required for verified GC floor`,
    );
  }
  await verifySnapshotTrustedHeadsForManifestFloor(ctx, state, manifest, snap, readEnvelopeAtSeq);
  anchorTrustedHeadsFromCoveringSnapshot(state, snap, manifest);
  state.appliedSnapshotEpoch = snap.epoch;
  state.verifiedManifestGeneration = manifest.manifest_generation;
  state.snapshotCompactedThrough = maxVectorSyncCursor(
    normalizeVectorSyncCursor(state.snapshotCompactedThrough),
    normalizeVectorSyncCursor(manifest.compacted_through),
  );
  return true;
}
