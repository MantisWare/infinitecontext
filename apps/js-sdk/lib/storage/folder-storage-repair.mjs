import fs from "node:fs";
import path from "node:path";

import { verifyDeviceLogThroughSeq } from "../object-store-chain-verify.mjs";
import { layoutRootPath, logSegmentRelativePath } from "./layout.mjs";
import { StorageError } from "./errors.mjs";
import { physicalKeyDirsForCanonicalKey } from "./folder-on-disk-scan.mjs";
import { canonicalizeConflictStorageKey, conflictSegmentToCanonical } from "./folder-conflict-copies.mjs";

const OBJECTS = "objects";
const QUARANTINE = "quarantine";

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {number} headSeq
 */
async function verifyDeviceLogFromZero(ctx, devH, headSeq) {
  if (headSeq < 0) return;
  const readEnvelopeAtSeq = async (seq) => {
    const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
    const row = await ctx.adapter.get(key);
    if (!row?.body) return null;
    const { decryptVaultStorageObjectPlaintext } = await import("./storage-object-move.mjs");
    const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
    return plain?.ic_layout_segment_envelope_v1 ?? null;
  };
  const headRow = await ctx.adapter.get(logSegmentRelativePath(ctx.layoutPrefix, devH, headSeq));
  if (!headRow?.body) {
    throw new StorageError(`Log replay failed: missing head segment for ${devH}`, "storage_fork");
  }
  const { layoutSegmentEnvelopeDigest } = await import("./layout.mjs");
  const headEnv = await readEnvelopeAtSeq(headSeq);
  if (!headEnv) {
    throw new StorageError(`Log replay failed for ${devH}`, "storage_fork");
  }
  const digest = layoutSegmentEnvelopeDigest(headEnv);
  await verifyDeviceLogThroughSeq(ctx, devH, { seq: headSeq, digest }, readEnvelopeAtSeq, headSeq);
}

/**
 * @param {string} rootDir folder adapter root
 * @param {string} relPath under objects/
 * @param {string} quarantineRoot
 */
function quarantineRelativePath(rootDir, relPath, quarantineRoot) {
  const src = path.join(rootDir, OBJECTS, relPath);
  if (!fs.existsSync(src)) return;
  const dest = path.join(quarantineRoot, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const stamp = Date.now();
  const finalDest = fs.existsSync(dest) ? `${dest}.${stamp}` : dest;
  fs.renameSync(src, finalDest);
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {{ dryRun?: boolean }} [options]
 */
export async function repairFolderObjectStoreVault(ctx, options = {}) {
  const folderAdapter = /** @type {{ rootDir?: string }} */ (ctx.adapter);
  const rootDir = folderAdapter.rootDir;
  if (!rootDir) {
    throw new StorageError("storage doctor --repair requires folder backend", "invalid_argument");
  }
  const { loadFolderMergedManifest } = await import("./storage-manifest-folder.mjs");
  const manifest = await loadFolderMergedManifest(ctx.adapter, ctx.dek, ctx.layoutPrefix);
  for (const row of manifest.devices) {
    const head = manifest.trusted_heads?.[row.devH];
    const headSeq = head?.seq ?? row.last_seq ?? -1;
    if (headSeq >= 0) {
      await verifyDeviceLogFromZero(ctx, row.devH, headSeq);
    }
  }
  const objectsRoot = path.join(rootDir, OBJECTS);
  const quarantineRoot = path.join(rootDir, QUARANTINE, String(Date.now()));
  /** @type {string[]} */
  const moved = [];
  if (!options.dryRun) {
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  }
  const snapPrefix = `${layoutRootPath(ctx.layoutPrefix)}/snap/`.toLowerCase();
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    if (key.toLowerCase().startsWith(snapPrefix)) {
      const rel = key;
      if (!options.dryRun) {
        for (const row of physicalKeyDirsForCanonicalKey(rootDir, key)) {
          const relDir = path.relative(objectsRoot, row.keyDir);
          quarantineRelativePath(rootDir, relDir, quarantineRoot);
        }
      }
      moved.push(key);
    }
  }
  const walkConflictDirs = (dir, relParts) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const mapped = conflictSegmentToCanonical(name);
      if (mapped && mapped !== name.toLowerCase()) {
        const relDir = [...relParts, name].join("/");
        if (!options.dryRun) {
          quarantineRelativePath(rootDir, relDir, quarantineRoot);
        }
        moved.push(canonicalizeConflictStorageKey([...relParts, mapped].join("/")));
        continue;
      }
      walkConflictDirs(full, [...relParts, name]);
    }
  };
  walkConflictDirs(objectsRoot, []);
  return { quarantineRoot: options.dryRun ? null : quarantineRoot, moved: [...new Set(moved)] };
}
