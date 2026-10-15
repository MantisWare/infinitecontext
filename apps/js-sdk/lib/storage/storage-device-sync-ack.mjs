import { deriveDevH, devHForObjectKey, deviceEncRelativePath } from "./layout.mjs";
import { normalizeVectorSyncCursor } from "../sync-cursor.mjs";
import { readLayoutObjectPlaintext, storageReadModifyWrite } from "./storage-cas-rmw.mjs";
import { usesFolderMergedDeviceManifest } from "./storage-adapter-policy.mjs";
import { upsertManifestDeviceAck } from "./storage-manifest.mjs";

export const DEVICE_SYNC_ACK_PLAIN_FIELD = "ic_layout_device_sync_v1";

/**
 * @typedef {Object} DeviceSyncAckRecord
 * @property {string} dev canonical lowercase device UUID
 * @property {number} acknowledged_seq highest self-log seq applied locally
 * @property {import('../sync-cursor.mjs').VectorSyncCursor} acknowledged_cursor merge cursor after last apply
 * @property {string} updated_at ISO-8601
 */

/** @param {DeviceSyncAckRecord} record */
export function wrapDeviceSyncAckPlain(record) {
  return { [DEVICE_SYNC_ACK_PLAIN_FIELD]: record };
}

/** @param {unknown} raw */
export function parseDeviceSyncAckPlain(raw) {
  if (!raw || typeof raw !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const inner = obj[DEVICE_SYNC_ACK_PLAIN_FIELD] ?? obj;
  if (!inner || typeof inner !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (inner);
  const dev = String(record.dev ?? "").trim().toLowerCase();
  if (!dev) return null;
  const acknowledgedSeq = Number(record.acknowledged_seq ?? -1);
  return {
    dev,
    acknowledged_seq: Number.isFinite(acknowledgedSeq) ? acknowledgedSeq : -1,
    acknowledged_cursor: normalizeVectorSyncCursor(record.acknowledged_cursor ?? 0),
    updated_at: String(record.updated_at ?? ""),
  };
}

/**
 * @param {Object} ctx
 * @param {import('./types.mjs').StorageAdapter} ctx.adapter
 * @param {Uint8Array} ctx.dek
 * @param {string} ctx.layoutPrefix
 * @param {string} ctx.ownerDevH
 * @param {string} ctx.deviceUuid
 * @param {import('../object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
export async function writeDeviceSyncAckFromState(ctx, state) {
  const ownerDevH = ctx.ownerDevH ?? ctx.selfDevH;
  const selfHead = state.trustedHeads[ownerDevH]?.seq ?? -1;
  let ackSeq = selfHead;
  if (!Number.isFinite(ackSeq) || ackSeq < 0) ackSeq = -1;
  /** @type {DeviceSyncAckRecord} */
  const record = {
    dev: String(ctx.deviceUuid).trim().toLowerCase(),
    acknowledged_seq: ackSeq,
    acknowledged_cursor: normalizeVectorSyncCursor(state.vectorCursor),
    updated_at: new Date().toISOString(),
  };
  if (usesFolderMergedDeviceManifest(ctx.adapter)) {
    const { updateFolderMergedManifest } = await import("./storage-manifest-folder.mjs");
    await updateFolderMergedManifest(
      {
        adapter: ctx.adapter,
        dek: ctx.dek,
        layoutPrefix: ctx.layoutPrefix,
        ownerDevH,
      },
      (manifest) => {
        upsertManifestDeviceAck(manifest, ownerDevH, record.acknowledged_seq, record.acknowledged_cursor);
        return manifest;
      },
    );
    return record;
  }
  const key = deviceEncRelativePath(ctx.layoutPrefix, ownerDevH);
  await storageReadModifyWrite({
    adapter: ctx.adapter,
    dek: ctx.dek,
    objectKey: key,
    layoutPrefix: ctx.layoutPrefix,
    lockName: `device-sync-${devHForObjectKey(ownerDevH)}`,
    ownerDevH,
    settleMs: 0,
    mutate: () => ({
      plaintext: wrapDeviceSyncAckPlain(record),
      result: record,
    }),
  });
  return record;
}

/**
 * @param {Object} ctx
 * @param {import('./types.mjs').StorageAdapter} ctx.adapter
 * @param {Uint8Array} ctx.dek
 * @param {string} ctx.layoutPrefix
 * @param {string} devH
 */
export async function loadDeviceSyncAck(ctx, devH) {
  const canon = devH.toUpperCase();
  if (usesFolderMergedDeviceManifest(ctx.adapter)) {
    const { loadFolderMergedManifest } = await import("./storage-manifest-folder.mjs");
    const manifest = await loadFolderMergedManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
    const row = manifest.devices.find((d) => d.devH === canon);
    if (!row) return null;
    return {
      dev: canon.toLowerCase(),
      acknowledged_seq: row.acknowledged_seq,
      acknowledged_cursor: row.acknowledged_cursor ?? normalizeVectorSyncCursor(0),
      updated_at: row.last_seen_at ?? "",
    };
  }
  const key = deviceEncRelativePath(ctx.layoutPrefix, canon);
  const row = await ctx.adapter.get(key);
  if (!row?.body) return null;
  const plain = readLayoutObjectPlaintext(ctx.dek, key, row.body);
  const parsed = parseDeviceSyncAckPlain(plain);
  if (!parsed) return null;
  const derived = deriveDevH(ctx.dek, parsed.dev);
  if (derived !== canon) return null;
  return parsed;
}

/**
 * Trusted ack for log `logDevH` from a participant's device sync record (untrusted → 0).
 * @param {DeviceSyncAckRecord | null} record
 * @param {string} participantDevH
 * @param {string} logDevH
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 */
export function trustedDeviceAckSeqForLog(record, participantDevH, logDevH, manifest) {
  if (!record) return 0;
  const participantCanon = participantDevH.toUpperCase();
  const logCanon = logDevH.toUpperCase();
  const headCap = manifest.trusted_heads?.[logCanon]?.seq;
  let ack = 0;
  if (logCanon === participantCanon) {
    ack = Number.isFinite(record.acknowledged_seq) && record.acknowledged_seq >= 0 ? record.acknowledged_seq : 0;
  } else {
    const cross = record.acknowledged_cursor?.v?.[logCanon];
    if (cross === undefined || !Number.isFinite(Number(cross)) || Number(cross) < 0) return 0;
    ack = Number(cross);
  }
  if (Number.isFinite(headCap) && headCap >= 0 && ack > headCap) ack = headCap;
  return ack;
}
