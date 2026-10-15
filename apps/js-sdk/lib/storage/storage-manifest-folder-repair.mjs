import { deviceEncRelativePath } from "./layout.mjs";
import { readLayoutObjectPlaintext, sealLayoutObjectPlaintext } from "./storage-cas-rmw.mjs";
import { StorageError } from "./errors.mjs";
import {
  mergeMaxDeviceContributions,
  parseDeviceSidecarPlain,
  wrapDeviceManifestContribution,
} from "./storage-manifest-folder.mjs";
import { physicalKeyDirsForCanonicalKey } from "./folder-on-disk-scan.mjs";
import { loadLatestObjectGenerationAtDir } from "./filesystem-generations.mjs";

/**
 * When sync conflict copies disagree on the owning device's manifest file, rewrite from
 * verified local state when it dominates both copies (max-merge fields first).
 *
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
export async function repairOwnDeviceManifestFileIfAuthoritative(ctx) {
  const folderAdapter = /** @type {{ inner?: import('./types.mjs').StorageAdapter, rootDir?: string }} */ (
    ctx.adapter
  );
  const inner = folderAdapter.inner ?? ctx.adapter;
  const rootDir = folderAdapter.rootDir;
  if (!rootDir || typeof inner.put !== "function") {
    return;
  }
  const ownerDevH = ctx.selfDevH.toUpperCase();
  const key = deviceEncRelativePath(ctx.layoutPrefix, ownerDevH);
  const state = ctx.localState.load();
  const localHead = state.trustedHeads[ownerDevH];
  if (!localHead || localHead.seq < 0) {
    return;
  }

  /** @type {import('./storage-manifest-folder.mjs').DeviceManifestContribution[]} */
  const parsedRows = [];
  for (const row of physicalKeyDirsForCanonicalKey(rootDir, key)) {
    let latest;
    try {
      latest = loadLatestObjectGenerationAtDir(rootDir, row.keyDir, row.canonicalKey);
    } catch (error) {
      if (error instanceof StorageError && error.code === "corrupt_storage") continue;
      throw error;
    }
    if (!latest?.body) continue;
    try {
      const plain = readLayoutObjectPlaintext(ctx.dek, key, latest.body);
      const parsed = parseDeviceSidecarPlain(plain, ctx.dek);
      if (parsed) parsedRows.push(parsed);
    } catch {
      throw new StorageError(
        `Undecryptable device manifest contribution at ${key}`,
        "corrupt_storage",
      );
    }
  }
  if (parsedRows.length <= 1) {
    return;
  }

  let merged;
  try {
    merged = mergeMaxDeviceContributions(parsedRows);
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "storage_fork")) {
      throw error;
    }
    merged = null;
  }

  for (const row of parsedRows) {
    const head = row.trusted_head;
    if (head && head.seq >= 0) {
      if (head.seq > localHead.seq) {
        throw new StorageError(
          `Device manifest fork for ${ownerDevH}; local trusted head lags conflict copies. Run \`infinitecontext storage doctor --repair\`.`,
          "storage_fork",
        );
      }
      if (head.seq === localHead.seq && head.digest !== localHead.digest) {
        throw new StorageError(
          `Device manifest fork for ${ownerDevH} at seq ${head.seq}. Run \`infinitecontext storage doctor --repair\`.`,
          "storage_fork",
        );
      }
    }
  }

  const base = merged ?? parsedRows[0];
  const repairFrom = {
    ...base,
    trusted_head: { seq: localHead.seq, digest: localHead.digest },
    last_seq: Math.max(base.last_seq ?? -1, localHead.seq),
    acknowledged_seq: Math.max(base.acknowledged_seq ?? -1, localHead.seq),
    record_generation: (base.record_generation ?? 0) + 1,
    latest_snapshot_epoch: -1,
    compacted_through: base.compacted_through,
    snapshot_digest: undefined,
  };
  const body = sealLayoutObjectPlaintext(ctx.dek, key, wrapDeviceManifestContribution(repairFrom));
  await inner.put(key, body);
}
