import { deviceEncRelativePath } from "./layout.mjs";
import { readLayoutObjectPlaintext, sealLayoutObjectPlaintext } from "./storage-cas-rmw.mjs";
import { StorageError } from "./errors.mjs";
import {
  parseDeviceManifestContribution,
  wrapDeviceManifestContribution,
} from "./storage-manifest-folder.mjs";
import { physicalKeyDirsForCanonicalKey } from "./folder-on-disk-scan.mjs";
import { loadLatestObjectGenerationAtDir } from "./filesystem-generations.mjs";

/**
 * When sync conflict copies disagree on the owning device's manifest file, rewrite from
 * verified local state when it dominates both copies.
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
    const latest = loadLatestObjectGenerationAtDir(rootDir, row.keyDir, row.canonicalKey);
    if (!latest?.body) continue;
    try {
      const plain = readLayoutObjectPlaintext(ctx.dek, key, latest.body);
      const parsed = parseDeviceManifestContribution(plain);
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

  /** @type {import('./storage-manifest-folder.mjs').DeviceManifestContribution | null} */
  let repairFrom = null;
  for (const row of parsedRows) {
    const head = row.trusted_head;
    if (!head || head.seq < 0) continue;
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
    if (!repairFrom || row.record_generation > repairFrom.record_generation) {
      repairFrom = row;
    }
  }
  if (!repairFrom) {
    return;
  }
  if (repairFrom.trusted_head?.seq !== localHead.seq || repairFrom.trusted_head?.digest !== localHead.digest) {
    repairFrom = {
      ...repairFrom,
      trusted_head: { seq: localHead.seq, digest: localHead.digest },
      record_generation: repairFrom.record_generation + 1,
    };
  }
  const body = sealLayoutObjectPlaintext(ctx.dek, key, wrapDeviceManifestContribution(repairFrom));
  await inner.put(key, body);
}
