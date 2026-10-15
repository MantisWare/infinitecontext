import fs from "node:fs";
import path from "node:path";

import { verifyDeviceLogThroughSeq } from "../object-store-chain-verify.mjs";
import { layoutRootPath, logSegmentRelativePath } from "./layout.mjs";
import { StorageError } from "./errors.mjs";
import {
  physicalKeyDirsForCanonicalKey,
  scanCanonicalKeysFromObjectsTree,
} from "./folder-on-disk-scan.mjs";
import { canonicalizeConflictStorageKey, conflictSegmentToCanonical } from "./folder-conflict-copies.mjs";
import { quarantineObjectsRelativePath } from "./folder-quarantine.mjs";
import { conflictResolutionHintForStorageKey } from "./folder-copy-resolution-hint.mjs";
import { ObjectStoreLogMissingError } from "../object-store-local-sync-state.mjs";

const OBJECTS = "objects";
const QUARANTINE = "quarantine";

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {string} devH
 * @param {number} headSeq
 * @param {string} headDigest
 */
async function verifyDeviceLogFromZero(ctx, devH, headSeq, headDigest) {
  if (headSeq < 0) return;
  const readEnvelopeAtSeq = async (seq) => {
    const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
    const row = await ctx.adapter.get(key);
    if (!row?.body) return null;
    const { decryptVaultStorageObjectPlaintext } = await import("./storage-object-move.mjs");
    const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
    return plain?.ic_layout_segment_envelope_v1 ?? null;
  };
  await verifyDeviceLogThroughSeq(ctx, devH, undefined, readEnvelopeAtSeq, headSeq);
  const headEnv = await readEnvelopeAtSeq(headSeq);
  if (!headEnv) {
    throw new StorageError(`Log replay failed: missing head segment for ${devH}`, "storage_fork");
  }
  const { layoutSegmentEnvelopeDigest } = await import("./layout.mjs");
  if (layoutSegmentEnvelopeDigest(headEnv) !== headDigest) {
    throw new StorageError(`Log head digest mismatch for ${devH} at seq ${headSeq}`, "storage_fork");
  }
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 */
async function assertNoForkedStorageKeys(ctx) {
  const folderAdapter = /** @type {{ rootDir?: string, listConflictGetCandidates?: (k: string) => Promise<unknown[]> }} */ (
    ctx.adapter
  );
  const rootDir = folderAdapter.rootDir;
  if (!rootDir) return;
  const objectsRoot = path.join(rootDir, OBJECTS);
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    if (typeof folderAdapter.listConflictGetCandidates === "function") {
      try {
        await folderAdapter.listConflictGetCandidates.call(ctx.adapter, key);
      } catch (error) {
        if (error instanceof StorageError && error.code === "storage_fork") {
          if (!error.message.includes("Resolve manually")) {
            throw new StorageError(
              `${error.message} ${conflictResolutionHintForStorageKey(key)}`,
              "storage_fork",
            );
          }
          throw error;
        }
        throw error;
      }
    }
  }
}

/**
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 */
/**
 * Chain-only log verify (seq 0 → head) without owner-written trusted head hints.
 *
 * @param {import('./object-store-sync.mjs').ObjectStoreSyncContext} ctx
 * @param {import('./storage-manifest.mjs').StorageManifest} manifest
 */
export async function verifyFolderDeviceLogsChainOnly(ctx, manifest) {
  for (const row of manifest.devices) {
    const headSeq = row.last_seq ?? -1;
    if (headSeq < 0) continue;
    const devH = row.devH;
    const readEnvelopeAtSeq = async (seq) => {
      const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
      const row = await ctx.adapter.get(key);
      if (!row?.body) return null;
      const { decryptVaultStorageObjectPlaintext } = await import("./storage-object-move.mjs");
      const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, row.body);
      return plain?.ic_layout_segment_envelope_v1 ?? null;
    };
    try {
      await verifyDeviceLogThroughSeq(ctx, devH, undefined, readEnvelopeAtSeq, headSeq);
    } catch (error) {
      if (error instanceof ObjectStoreLogMissingError) {
        throw new StorageError(error.message, "storage_fork");
      }
      throw error;
    }
  }
}

export async function verifyFolderDeviceLogsForManifest(ctx, manifest) {
  for (const row of manifest.devices) {
    const head = manifest.trusted_heads?.[row.devH];
    const headSeq = head?.seq ?? row.last_seq ?? -1;
    if (headSeq < 0) continue;
    if (!head?.digest) {
      throw new StorageError(
        `Device ${row.devH} missing owner-written trusted head digest; repair refused`,
        "storage_fork",
      );
    }
    try {
      await verifyDeviceLogFromZero(ctx, row.devH, headSeq, head.digest);
    } catch (error) {
      if (error instanceof ObjectStoreLogMissingError) {
        throw new StorageError(error.message, "storage_fork");
      }
      throw error;
    }
  }
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
  await assertNoForkedStorageKeys(ctx);
  await verifyFolderDeviceLogsForManifest(ctx, manifest);

  const objectsRoot = path.join(rootDir, OBJECTS);
  const quarantineRoot = path.join(rootDir, QUARANTINE, "repair");
  /** @type {string[]} */
  const moved = [];
  if (!options.dryRun) {
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  }
  const snapPrefix = `${layoutRootPath(ctx.layoutPrefix)}/snap/`.toLowerCase();
  for (const key of scanCanonicalKeysFromObjectsTree(objectsRoot)) {
    if (key.toLowerCase().startsWith(snapPrefix)) {
      for (const row of physicalKeyDirsForCanonicalKey(rootDir, key)) {
        const relDir = path.relative(objectsRoot, row.keyDir);
        if (!options.dryRun) {
          if (quarantineObjectsRelativePath(rootDir, relDir, quarantineRoot)) {
            moved.push(key);
          }
        } else {
          moved.push(key);
        }
      }
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
          if (quarantineObjectsRelativePath(rootDir, relDir, quarantineRoot)) {
            moved.push(canonicalizeConflictStorageKey([...relParts, mapped].join("/")));
          }
        } else {
          moved.push(canonicalizeConflictStorageKey([...relParts, mapped].join("/")));
        }
        continue;
      }
      walkConflictDirs(full, [...relParts, name]);
    }
  };
  walkConflictDirs(objectsRoot, []);
  return { quarantineRoot: options.dryRun ? null : quarantineRoot, moved: [...new Set(moved)] };
}
