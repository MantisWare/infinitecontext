import { deriveDevH, deviceEncRelativePath, devHForObjectKey, layoutRootPath } from "./layout.mjs";
import { parseDeviceSyncAckPlain } from "./storage-device-sync-ack.mjs";
import { maxVectorSyncCursor, normalizeVectorSyncCursor } from "../sync-cursor.mjs";
import {
  createEmptyStorageManifest,
  mergeTrustedHeadsMonotonic,
  parseStorageManifestPlain,
  sanitizeManifestDeviceAcks,
  wrapStorageManifestPlain,
} from "./storage-manifest.mjs";
import { readLayoutObjectPlaintext, sealLayoutObjectPlaintext } from "./storage-cas-rmw.mjs";
import { StorageError } from "./errors.mjs";

export const DEVICE_MANIFEST_CONTRIBUTION_FIELD = "ic_layout_device_manifest_v2";

/**
 * @typedef {Object} DeviceManifestContribution
 * @property {string} devH uppercase
 * @property {number} record_generation monotonic per device file
 * @property {boolean} sync_participant
 * @property {number} last_seq
 * @property {number} acknowledged_seq
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} [acknowledged_cursor]
 * @property {string} [last_seen_at]
 * @property {{ seq: number, digest: string }} [trusted_head] self only
 * @property {number} latest_snapshot_epoch
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} compacted_through
 * @property {string} [snapshot_digest] hex digest of snap/<epoch>.enc when epoch >= 0
 * @property {string[]} removed_devices
 */

/** @param {DeviceManifestContribution} row */
export function wrapDeviceManifestContribution(row) {
  return { [DEVICE_MANIFEST_CONTRIBUTION_FIELD]: row };
}

/** @param {import('./storage-device-sync-ack.mjs').DeviceSyncAckRecord} ack @param {string} devH */
export function contributionFromLegacyDeviceSyncAck(ack, devH) {
  const seq = Number.isFinite(ack.acknowledged_seq) && ack.acknowledged_seq >= 0 ? ack.acknowledged_seq : -1;
  return {
    devH: devH.toUpperCase(),
    record_generation: 0,
    sync_participant: true,
    last_seq: seq,
    acknowledged_seq: seq,
    acknowledged_cursor: ack.acknowledged_cursor,
    last_seen_at: ack.updated_at || new Date().toISOString(),
    latest_snapshot_epoch: -1,
    compacted_through: normalizeVectorSyncCursor(0),
    removed_devices: [],
  };
}

/** @param {unknown} raw @param {Uint8Array} dek */
export function parseDeviceSidecarPlain(raw, dek) {
  const v2 = parseDeviceManifestContribution(raw);
  if (v2) return v2;
  if (!raw || typeof raw !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const ack = parseDeviceSyncAckPlain(raw);
  if (!ack) return null;
  const devH = deriveDevH(dek, ack.dev);
  return contributionFromLegacyDeviceSyncAck(ack, devH);
}

/** @param {unknown} raw */
export function parseDeviceManifestContribution(raw) {
  if (!raw || typeof raw !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const inner = obj[DEVICE_MANIFEST_CONTRIBUTION_FIELD] ?? obj;
  if (!inner || typeof inner !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (inner);
  const devH = String(record.devH ?? "").toUpperCase();
  if (!devH) return null;
  const trustedRaw = record.trusted_head;
  let trusted_head;
  if (trustedRaw && typeof trustedRaw === "object") {
    const t = /** @type {Record<string, unknown>} */ (trustedRaw);
    trusted_head = {
      seq: Number(t.seq ?? -1),
      digest: String(t.digest ?? ""),
    };
  }
  return {
    devH,
    record_generation: Number(record.record_generation ?? 0),
    sync_participant: Boolean(record.sync_participant),
    last_seq: Number(record.last_seq ?? -1),
    acknowledged_seq: Number(record.acknowledged_seq ?? -1),
    acknowledged_cursor:
      record.acknowledged_cursor !== undefined
        ? normalizeVectorSyncCursor(record.acknowledged_cursor)
        : undefined,
    last_seen_at: typeof record.last_seen_at === "string" ? record.last_seen_at : undefined,
    trusted_head,
    latest_snapshot_epoch: Number(record.latest_snapshot_epoch ?? -1),
    compacted_through: normalizeVectorSyncCursor(record.compacted_through ?? 0),
    snapshot_digest:
      typeof record.snapshot_digest === "string" && record.snapshot_digest ? record.snapshot_digest : undefined,
    removed_devices: Array.isArray(record.removed_devices)
      ? record.removed_devices.map((d) => String(d).toUpperCase())
      : [],
  };
}

/** @param {DeviceManifestContribution} a @param {DeviceManifestContribution} b */
export function mergeMaxDeviceContributionPair(a, b) {
  if (a.trusted_head && b.trusted_head && a.trusted_head.seq === b.trusted_head.seq) {
    if (a.trusted_head.digest !== b.trusted_head.digest) {
      throw new StorageError(
        `Device manifest fork for ${a.devH} at seq ${a.trusted_head.seq}`,
        "storage_fork",
      );
    }
  }
  const trusted =
    !a.trusted_head
      ? b.trusted_head
      : !b.trusted_head
        ? a.trusted_head
        : a.trusted_head.seq >= b.trusted_head.seq
          ? a.trusted_head
          : b.trusted_head;
  const tupleA = `${a.latest_snapshot_epoch}:${JSON.stringify(a.compacted_through)}:${a.snapshot_digest ?? ""}`;
  const tupleB = `${b.latest_snapshot_epoch}:${JSON.stringify(b.compacted_through)}:${b.snapshot_digest ?? ""}`;
  if (tupleA !== tupleB) {
    throw new StorageError(
      `Device manifest compaction tuple fork for ${a.devH}`,
      "storage_fork",
    );
  }
  return {
    devH: a.devH,
    record_generation: Math.max(a.record_generation, b.record_generation),
    sync_participant: a.sync_participant || b.sync_participant,
    last_seq: Math.max(a.last_seq, b.last_seq),
    acknowledged_seq: Math.max(a.acknowledged_seq, b.acknowledged_seq),
    acknowledged_cursor: maxVectorSyncCursor(
      a.acknowledged_cursor ?? normalizeVectorSyncCursor(0),
      b.acknowledged_cursor ?? normalizeVectorSyncCursor(0),
    ),
    last_seen_at: a.last_seen_at && b.last_seen_at ? (a.last_seen_at > b.last_seen_at ? a.last_seen_at : b.last_seen_at) : (a.last_seen_at ?? b.last_seen_at),
    trusted_head: trusted,
    latest_snapshot_epoch: a.latest_snapshot_epoch,
    compacted_through: a.compacted_through,
    snapshot_digest: a.snapshot_digest ?? b.snapshot_digest,
    removed_devices: [...new Set([...(a.removed_devices ?? []), ...(b.removed_devices ?? [])])],
  };
}

/** @param {DeviceManifestContribution[]} rows */
export function mergeMaxDeviceContributions(rows) {
  if (!rows.length) return null;
  let acc = rows[0];
  for (let i = 1; i < rows.length; i += 1) {
    acc = mergeMaxDeviceContributionPair(acc, rows[i]);
  }
  return acc;
}

/** @param {DeviceManifestContribution[]} contributions */
export function mergeDeviceManifestContributions(contributions) {
  const manifest = createEmptyStorageManifest();
  /** @type {Map<string, import('./storage-manifest.mjs').ManifestDeviceRow>} */
  const deviceRows = new Map();
  /** @type {Set<string>} */
  const participants = new Set();
  /** @type {Set<string>} */
  const removed = new Set();
  let maxRecordGen = 0;
  for (const row of contributions) {
    if (!row) continue;
    maxRecordGen = Math.max(maxRecordGen, row.record_generation ?? 0);
    if (row.sync_participant) participants.add(row.devH);
    for (const id of row.removed_devices ?? []) removed.add(id);
    if (row.trusted_head && Number.isFinite(row.trusted_head.seq)) {
      manifest.trusted_heads = mergeTrustedHeadsMonotonic(manifest.trusted_heads, {
        [row.devH]: row.trusted_head,
      });
    }
    const existing = deviceRows.get(row.devH);
    const merged = {
      devH: row.devH,
      last_seq: Math.max(existing?.last_seq ?? -1, row.last_seq ?? -1),
      acknowledged_seq: Math.max(existing?.acknowledged_seq ?? -1, row.acknowledged_seq ?? -1),
      acknowledged_cursor: row.acknowledged_cursor ?? existing?.acknowledged_cursor,
      last_seen_at: row.last_seen_at ?? existing?.last_seen_at,
    };
    if (merged.acknowledged_cursor && existing?.acknowledged_cursor) {
      merged.acknowledged_cursor = maxVectorSyncCursor(
        existing.acknowledged_cursor,
        merged.acknowledged_cursor,
      );
    }
    deviceRows.set(row.devH, merged);
  }
  manifest.devices = [...deviceRows.values()];
  manifest.sync_participants = [...participants];
  manifest.removed_devices = [...removed];
  manifest.manifest_generation = maxRecordGen;
  sanitizeManifestDeviceAcks(manifest);
  return manifest;
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 */
export async function loadAllDeviceManifestContributions(adapter, dek, layoutPrefix) {
  const prefix = `${layoutRootPath(layoutPrefix)}/devices/`;
  /** @type {DeviceManifestContribution[]} */
  const out = [];
  let cursor;
  for (;;) {
    const page = await adapter.list(prefix, { limit: 200, cursor });
    for (const row of page.objects) {
      /** @type {DeviceManifestContribution[]} */
      const parsedRows = [];
      const bodies = await loadDeviceContributionBodies(adapter, dek, row.key);
      for (const body of bodies) {
        try {
          const plain = readLayoutObjectPlaintext(dek, row.key, body);
          const parsed = parseDeviceSidecarPlain(plain, dek);
          if (parsed) parsedRows.push(parsed);
        } catch (error) {
          throw error instanceof StorageError
            ? error
            : new StorageError(
                `Undecryptable device manifest contribution at ${row.key}`,
                "corrupt_storage",
              );
        }
      }
      if (bodies.length > 0 && parsedRows.length === 0) {
        throw new StorageError(
          `Undecryptable device manifest contribution at ${row.key}`,
          "corrupt_storage",
        );
      }
      let merged;
      try {
        merged = mergeMaxDeviceContributions(parsedRows);
      } catch (error) {
        if (error instanceof StorageError && error.code === "storage_fork") {
          throw new StorageError(
            `${error.message}. Run \`infinitecontext storage doctor --repair\` on the owning device.`,
            "storage_fork",
          );
        }
        throw error;
      }
      if (merged) out.push(merged);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} objectKey
 * @returns {Promise<Uint8Array[]>}
 */
async function loadDeviceContributionBodies(adapter, dek, objectKey) {
  const conflictAware = /** @type {{ loadContributionBodiesForKey?: (k: string) => Promise<Uint8Array[]> }} */ (
    adapter
  ).loadContributionBodiesForKey;
  if (typeof conflictAware === "function") {
    return conflictAware.call(adapter, objectKey);
  }
  const row = await adapter.get(objectKey);
  return row?.body ? [row.body] : [];
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 */
export async function migrateLegacyFolderDeviceSidecars(adapter, dek, layoutPrefix) {
  const prefix = `${layoutRootPath(layoutPrefix)}/devices/`;
  let cursor;
  for (;;) {
    const page = await adapter.list(prefix, { limit: 200, cursor });
    for (const row of page.objects) {
      const got = await adapter.get(row.key);
      if (!got?.body) continue;
      let plain;
      try {
        plain = readLayoutObjectPlaintext(dek, row.key, got.body);
      } catch {
        continue;
      }
      if (parseDeviceManifestContribution(plain)) continue;
      const migrated = parseDeviceSidecarPlain(plain, dek);
      if (!migrated) continue;
      const body = sealLayoutObjectPlaintext(dek, row.key, wrapDeviceManifestContribution(migrated));
      await adapter.put(row.key, body);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}

export async function loadFolderMergedManifest(adapter, dek, layoutPrefix) {
  await migrateLegacyFolderDeviceSidecars(adapter, dek, layoutPrefix);
  const contributions = await loadAllDeviceManifestContributions(adapter, dek, layoutPrefix);
  if (!contributions.length) return createEmptyStorageManifest();
  const manifest = mergeDeviceManifestContributions(contributions);
  const { compactionClaimFromDeviceContribution, pickVerifiedCompactionFloor } = await import(
    "./compaction-floor-tuple.mjs"
  );
  const claims = contributions
    .map((row) => compactionClaimFromDeviceContribution(row))
    .filter(Boolean);
  const floor = await pickVerifiedCompactionFloor({ adapter, dek, layoutPrefix }, claims);
  manifest.latest_snapshot_epoch = floor.epoch;
  manifest.compacted_through = floor.compacted_through;
  return manifest;
}

/**
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 * @param {string} ownerDevH
 * @param {DeviceManifestContribution | null} previous
 */
export function contributionFromOwnerManifestView(manifest, ownerDevH, previous) {
  const canon = ownerDevH.toUpperCase();
  const row = manifest.devices.find((d) => d.devH === canon);
  const head = manifest.trusted_heads?.[canon];
  return {
    devH: canon,
    record_generation: (previous?.record_generation ?? 0) + 1,
    sync_participant: (manifest.sync_participants ?? []).includes(canon),
    last_seq: row?.last_seq ?? previous?.last_seq ?? -1,
    acknowledged_seq: row?.acknowledged_seq ?? previous?.acknowledged_seq ?? -1,
    acknowledged_cursor: row?.acknowledged_cursor ?? previous?.acknowledged_cursor,
    last_seen_at: row?.last_seen_at ?? new Date().toISOString(),
    trusted_head: head ? { seq: head.seq, digest: head.digest } : previous?.trusted_head,
    latest_snapshot_epoch: manifest.latest_snapshot_epoch,
    compacted_through: manifest.compacted_through,
    removed_devices: manifest.removed_devices ?? [],
  };
}

/**
 * @param {Object} ctx
 * @param {import('./types.mjs').StorageAdapter} ctx.adapter
 * @param {Uint8Array} ctx.dek
 * @param {string} ctx.layoutPrefix
 * @param {string} ctx.ownerDevH
 * @param {(manifest: import('./storage-manifest.mjs').StorageManifest) => import('./storage-manifest.mjs').StorageManifest | Promise<import('./storage-manifest.mjs').StorageManifest>} mutate
 */
export async function updateFolderMergedManifest(ctx, mutate) {
  const merged = await loadFolderMergedManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
  const draft = parseStorageManifestPlain(wrapStorageManifestPlain(merged));
  const next = await mutate(draft);
  const key = deviceEncRelativePath(ctx.layoutPrefix, ctx.ownerDevH);
  const prevRow = await ctx.adapter.get(key);
  let previous = null;
  if (prevRow?.body) {
    try {
      const plain = readLayoutObjectPlaintext(ctx.dek, key, prevRow.body);
      previous = parseDeviceManifestContribution(plain);
    } catch {
      previous = null;
    }
  }
  let contribution = contributionFromOwnerManifestView(next, ctx.ownerDevH, previous);
  if (contribution.latest_snapshot_epoch >= 0) {
    const { loadSnapshotBodyDigest } = await import("./compaction-floor-tuple.mjs");
    const digest = await loadSnapshotBodyDigest(
      { adapter: ctx.adapter, dek: ctx.dek, layoutPrefix: ctx.layoutPrefix },
      contribution.latest_snapshot_epoch,
    );
    contribution = { ...contribution, snapshot_digest: digest ?? undefined };
  }
  const body = sealLayoutObjectPlaintext(ctx.dek, key, wrapDeviceManifestContribution(contribution));
  if (!prevRow) {
    await ctx.adapter.put(key, body, { ifNoneMatch: "*" });
  } else {
    await ctx.adapter.put(key, body);
  }
  return mergeDeviceManifestContributions([
    ...(await loadAllDeviceManifestContributions(ctx.adapter, ctx.dek, ctx.layoutPrefix)).filter(
      (c) => c.devH !== ctx.ownerDevH.toUpperCase(),
    ),
    contribution,
  ]);
}
