import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { readConfigFile, writeConfigFile } from "../client-config.mjs";
import { createFolderStorageAdapter } from "./folder-adapter.mjs";
import { verifyDeviceLogThroughSeq } from "../object-store-chain-verify.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";
import { initFolderStorageRoot } from "./storage-init.mjs";
import { StorageError } from "./errors.mjs";
import { deriveDevH, logSegmentRelativePath } from "./layout.mjs";

const OBJECTS = "objects";

/**
 * @param {import("../object-store-sync.mjs").ObjectStoreSyncContext} ctx
 * @param {import("./storage-manifest.mjs").StorageManifest} manifest
 */
async function verifyFolderCopiedDeviceLogsFull(ctx, manifest) {
  for (const row of manifest.devices) {
    const headSeq = row.last_seq ?? -1;
    if (headSeq < 0) continue;
    const devH = row.devH;
    const readEnvelopeAtSeq = async (seq) => {
      const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
      const got = await ctx.adapter.get(key);
      if (!got?.body) return null;
      const { decryptVaultStorageObjectPlaintext } = await import("./storage-object-move.mjs");
      const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, got.body);
      return plain?.ic_layout_segment_envelope_v1 ?? null;
    };
    await verifyDeviceLogThroughSeq(ctx, devH, undefined, readEnvelopeAtSeq, headSeq);
  }
}

/**
 * @param {string} scopeKey
 */
export function storageMigrateStatePath(scopeKey) {
  const safe = String(scopeKey).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(infinitecontextHome(), `storage-migrate-${safe}.json`);
}

/**
 * @param {string} scopeKey
 */
export function loadStorageMigrateState(scopeKey) {
  const file = storageMigrateStatePath(scopeKey);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} scopeKey
 * @param {Record<string, unknown>} state
 */
export function saveStorageMigrateState(scopeKey, state) {
  const file = storageMigrateStatePath(scopeKey);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const body = `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  const fd = fs.openSync(tmp, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listRegularFilesRecursive(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (cursor) => {
    let entries;
    try {
      entries = fs.readdirSync(cursor, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(cursor, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * @param {string} scopeKey
 * @param {{
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   sourceRoot: string,
 *   destRoot: string,
 *   deviceUuid: string,
 *   maxCopyFiles?: number,
 *   applyConfig?: boolean,
 * }} options
 */
export async function runStorageMigrateLocalToFolder(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const destRoot = path.resolve(options.destRoot);
  const scopeKey = options.scopeKey ?? `${sourceRoot}->${destRoot}`;
  const srcObjects = path.join(sourceRoot, OBJECTS);
  if (!fs.existsSync(srcObjects)) {
    throw new StorageError(`Local migrate source missing ${OBJECTS}/`, "invalid_argument");
  }
  initFolderStorageRoot(destRoot);
  const destObjects = path.join(destRoot, OBJECTS);

  let state = loadStorageMigrateState(scopeKey);
  if (!state || state.sourceRoot !== sourceRoot || state.destRoot !== destRoot) {
    state = {
      sourceRoot,
      destRoot,
      layoutPrefix: options.layoutPrefix,
      copiedRelativePaths: [],
      verified: false,
      configApplied: false,
    };
    saveStorageMigrateState(scopeKey, state);
  }

  const copiedSet = new Set(state.copiedRelativePaths ?? []);
  const allSrcFiles = listRegularFilesRecursive(srcObjects);
  let copiedThisRun = 0;
  const max = options.maxCopyFiles ?? Number.POSITIVE_INFINITY;

  for (const abs of allSrcFiles) {
    const relFromSrcRoot = path.relative(sourceRoot, abs);
    if (copiedSet.has(relFromSrcRoot)) continue;
    if (copiedThisRun >= max) break;
    const destPath = path.join(destRoot, relFromSrcRoot);
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(abs, destPath);
    copiedSet.add(relFromSrcRoot);
    copiedThisRun += 1;
    state.copiedRelativePaths = [...copiedSet];
    saveStorageMigrateState(scopeKey, state);
  }

  const pending = allSrcFiles.some((abs) => !copiedSet.has(path.relative(sourceRoot, abs)));
  if (pending) {
    return {
      phase: "copying",
      copiedCount: copiedSet.size,
      pending: allSrcFiles.length - copiedSet.size,
    };
  }

  if (!state.verified) {
    const adapter = createFolderStorageAdapter({ rootDir: destRoot, placeholderTimeoutMs: 80 });
    await adapter.init();
    const manifest = await loadFolderMergedManifest(adapter, options.dek, options.layoutPrefix);
    await verifyFolderCopiedDeviceLogsFull(
      {
        adapter,
        dek: options.dek,
        layoutPrefix: options.layoutPrefix,
        selfDevH: deriveDevH(options.dek, options.deviceUuid),
        deviceUuid: options.deviceUuid,
        localState: { load: () => ({}), save: async () => {} },
      },
      manifest,
    );
    state.verified = true;
    saveStorageMigrateState(scopeKey, state);
    await adapter.close();
  }

  if (options.applyConfig && !state.configApplied) {
    const existing = readConfigFile();
    const storage =
      existing.storage && typeof existing.storage === "object" && !Array.isArray(existing.storage)
        ? { ...existing.storage }
        : {};
    writeConfigFile({
      storage: {
        ...storage,
        backend: "folder",
        folder: { path: destRoot },
        deviceUuid: options.deviceUuid,
      },
    });
    state.configApplied = true;
    saveStorageMigrateState(scopeKey, state);
  }

  return {
    phase: state.configApplied ? "config_applied" : "verified",
    copiedCount: copiedSet.size,
    verified: true,
    configApplied: Boolean(state.configApplied),
  };
}
