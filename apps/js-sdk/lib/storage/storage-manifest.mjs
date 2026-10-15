import { manifestEncRelativePath } from "./layout.mjs";
import { normalizeVectorSyncCursor } from "../sync-cursor.mjs";
import { storageReadModifyWrite, readLayoutObjectPlaintext } from "./storage-cas-rmw.mjs";

export const MANIFEST_FORMAT = 1;
const MANIFEST_PLAIN_FIELD = "ic_layout_manifest_v1";

/**
 * @typedef {Object} ManifestDeviceRow
 * @property {string} devH canonical uppercase
 * @property {number} last_seq highest segment seq written (hint)
 * @property {number} acknowledged_seq highest seq applied by this device
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} [acknowledged_cursor] merge cursor after last pull
 */

/**
 * @typedef {Object} StorageManifest
 * @property {number} format
 * @property {ManifestDeviceRow[]} devices
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} compacted_through
 * @property {number} latest_snapshot_epoch
 * @property {Record<string, { seq: number, digest: string }>} [trusted_heads]
 */

/** @returns {StorageManifest} */
export function createEmptyStorageManifest() {
  return {
    format: MANIFEST_FORMAT,
    devices: [],
    compacted_through: normalizeVectorSyncCursor(0),
    latest_snapshot_epoch: -1,
    trusted_heads: {},
  };
}

/** @param {unknown} raw */
export function parseStorageManifestPlain(raw) {
  if (!raw || typeof raw !== "object") return createEmptyStorageManifest();
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const inner = obj[MANIFEST_PLAIN_FIELD] ?? obj;
  const record = inner && typeof inner === "object" ? /** @type {Record<string, unknown>} */ (inner) : {};
  const devicesRaw = Array.isArray(record.devices) ? record.devices : [];
  /** @type {ManifestDeviceRow[]} */
  const devices = [];
  for (const row of devicesRaw) {
    if (!row || typeof row !== "object") continue;
    const devH = String(/** @type {Record<string, unknown>} */ (row).devH ?? "");
    if (!devH) continue;
    const ackCursorRaw = /** @type {Record<string, unknown>} */ (row).acknowledged_cursor;
    devices.push({
      devH,
      last_seq: Number(/** @type {Record<string, unknown>} */ (row).last_seq ?? -1),
      acknowledged_seq: Number(/** @type {Record<string, unknown>} */ (row).acknowledged_seq ?? -1),
      acknowledged_cursor:
        ackCursorRaw !== undefined && ackCursorRaw !== null
          ? normalizeVectorSyncCursor(ackCursorRaw)
          : undefined,
    });
  }
  return {
    format: Number(record.format ?? MANIFEST_FORMAT),
    devices,
    compacted_through: normalizeVectorSyncCursor(record.compacted_through ?? 0),
    latest_snapshot_epoch: Number(record.latest_snapshot_epoch ?? -1),
    trusted_heads:
      record.trusted_heads && typeof record.trusted_heads === "object"
        ? /** @type {Record<string, { seq: number, digest: string }>} */ (record.trusted_heads)
        : {},
  };
}

/** @param {StorageManifest} manifest */
export function wrapStorageManifestPlain(manifest) {
  return { [MANIFEST_PLAIN_FIELD]: manifest };
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 */
export async function loadStorageManifest(adapter, dek, layoutPrefix) {
  const key = manifestEncRelativePath(layoutPrefix);
  const row = await adapter.get(key);
  if (!row?.body) return createEmptyStorageManifest();
  const plain = readLayoutObjectPlaintext(dek, key, row.body);
  return parseStorageManifestPlain(plain);
}

/**
 * @param {Object} ctx
 * @param {import('./types.mjs').StorageAdapter} ctx.adapter
 * @param {Uint8Array} ctx.dek
 * @param {string} ctx.layoutPrefix
 * @param {string} ctx.ownerDevH
 * @param {(manifest: StorageManifest) => StorageManifest | Promise<StorageManifest>} mutate
 * @param {number} [ctx.settleMs]
 */
export async function updateStorageManifest(ctx, mutate) {
  const key = manifestEncRelativePath(ctx.layoutPrefix);
  return storageReadModifyWrite({
    adapter: ctx.adapter,
    dek: ctx.dek,
    objectKey: key,
    layoutPrefix: ctx.layoutPrefix,
    lockName: "manifest",
    ownerDevH: ctx.ownerDevH,
    settleMs: ctx.settleMs,
    mutate: async (current) => {
      const manifest = parseStorageManifestPlain(current);
      const next = await mutate(manifest);
      return { plaintext: wrapStorageManifestPlain(next), result: next };
    },
  });
}

/**
 * @param {StorageManifest} manifest
 * @param {string} devH
 * @param {number} acknowledgedSeq
 * @param {import('../sync-cursor.mjs').VectorSyncCursor} [acknowledgedCursor]
 */
export function upsertManifestDeviceAck(manifest, devH, acknowledgedSeq, acknowledgedCursor) {
  const canon = devH.toUpperCase();
  let row = manifest.devices.find((d) => d.devH === canon);
  if (!row) {
    row = { devH: canon, last_seq: acknowledgedSeq, acknowledged_seq: acknowledgedSeq };
    manifest.devices.push(row);
  } else {
    row.acknowledged_seq = Math.max(row.acknowledged_seq, acknowledgedSeq);
    row.last_seq = Math.max(row.last_seq, acknowledgedSeq);
  }
  if (acknowledgedCursor) {
    row.acknowledged_cursor = normalizeVectorSyncCursor(acknowledgedCursor);
  }
}

/** @param {StorageManifest} manifest */
export function minAcknowledgedSeqAcrossDevices(manifest) {
  if (!manifest.devices.length) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const row of manifest.devices) {
    if (!Number.isFinite(row.acknowledged_seq) || row.acknowledged_seq < 0) continue;
    min = Math.min(min, row.acknowledged_seq);
  }
  return Number.isFinite(min) ? min : null;
}
