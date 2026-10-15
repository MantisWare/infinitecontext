import { bytesToHex } from "@noble/hashes/utils";

import { normalizeVectorSyncCursor } from "../sync-cursor.mjs";
import { storageObjectDigest } from "./ciphertext.mjs";
import { loadStorageSnapshot, verifySnapshotTrustedHeads } from "./storage-compaction.mjs";

/**
 * @typedef {Object} CompactionFloorClaim
 * @property {number} epoch
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} compacted_through
 * @property {string} snapshot_digest hex digest of snapshot ciphertext body
 */

/** @param {Uint8Array} body */
export function computeSnapshotObjectDigest(body) {
  return bytesToHex(storageObjectDigest(body));
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {number} epoch
 */
export async function loadSnapshotBodyDigest(ctx, epoch) {
  const { snapEncRelativePath } = await import("./layout.mjs");
  const key = snapEncRelativePath(ctx.layoutPrefix, epoch);
  const row = await ctx.adapter.get(key);
  if (!row?.body) return null;
  return computeSnapshotObjectDigest(row.body);
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {CompactionFloorClaim} claim
 */
export async function verifyCompactionFloorClaim(ctx, claim) {
  const digest = await loadSnapshotBodyDigest(ctx, claim.epoch);
  if (!digest || digest !== claim.snapshot_digest) return false;
  const snap = await loadStorageSnapshot(ctx, claim.epoch);
  if (!snap) return false;
  try {
    await verifySnapshotTrustedHeads(ctx, snap);
  } catch {
    return false;
  }
  const snapCompacted = normalizeVectorSyncCursor(snap.compacted_through);
  const claimCompacted = normalizeVectorSyncCursor(claim.compacted_through);
  return JSON.stringify(snapCompacted) === JSON.stringify(claimCompacted);
}

/**
 * Highest verified claim, else seq-0 floor (epoch -1).
 *
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {CompactionFloorClaim[]} claims
 */
export async function pickVerifiedCompactionFloor(ctx, claims) {
  const sorted = [...claims].sort((a, b) => b.epoch - a.epoch);
  for (const claim of sorted) {
    if (!Number.isFinite(claim.epoch) || claim.epoch < 0) continue;
    if (await verifyCompactionFloorClaim(ctx, claim)) {
      return {
        epoch: claim.epoch,
        compacted_through: normalizeVectorSyncCursor(claim.compacted_through),
      };
    }
  }
  return {
    epoch: -1,
    compacted_through: normalizeVectorSyncCursor(0),
  };
}

/**
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {string | null} snapshotDigest
 * @returns {CompactionFloorClaim | null}
 */
export function compactionClaimFromManifest(manifest, snapshotDigest) {
  if (manifest.latest_snapshot_epoch < 0 || !snapshotDigest) return null;
  return {
    epoch: manifest.latest_snapshot_epoch,
    compacted_through: normalizeVectorSyncCursor(manifest.compacted_through),
    snapshot_digest: snapshotDigest,
  };
}

/**
 * @param {import('./storage-manifest-folder.mjs').DeviceManifestContribution} row
 * @returns {CompactionFloorClaim | null}
 */
export function compactionClaimFromDeviceContribution(row) {
  if (!row || row.latest_snapshot_epoch < 0 || !row.snapshot_digest) return null;
  return {
    epoch: row.latest_snapshot_epoch,
    compacted_through: normalizeVectorSyncCursor(row.compacted_through),
    snapshot_digest: row.snapshot_digest,
  };
}

/**
 * Apply verified compaction floor to manifest (never max-merge epoch and vector independently).
 *
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {CompactionFloorClaim[]} [extraClaims]
 */
export async function applyVerifiedCompactionFloorToManifest(
  adapter,
  dek,
  layoutPrefix,
  manifest,
  extraClaims = [],
) {
  /** @type {CompactionFloorClaim[]} */
  const claims = [...extraClaims];
  if (manifest.latest_snapshot_epoch >= 0) {
    const digest = await loadSnapshotBodyDigest({ adapter, dek, layoutPrefix }, manifest.latest_snapshot_epoch);
    const fromManifest = compactionClaimFromManifest(manifest, digest);
    if (fromManifest) claims.push(fromManifest);
  }
  const floor = await pickVerifiedCompactionFloor({ adapter, dek, layoutPrefix }, claims);
  manifest.latest_snapshot_epoch = floor.epoch;
  manifest.compacted_through = floor.compacted_through;
  return manifest;
}
