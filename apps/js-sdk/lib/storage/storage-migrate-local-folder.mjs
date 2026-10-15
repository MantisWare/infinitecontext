import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { readConfigFile, writeConfigFile } from "../client-config.mjs";
import { createFolderStorageAdapter } from "./folder-adapter.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";
import { initFolderStorageRoot } from "./storage-init.mjs";
import { StorageError } from "./errors.mjs";
import { deriveDevH } from "./layout.mjs";
import { verifyFolderDeviceLogsChainOnly } from "./folder-storage-repair.mjs";
import { storageVaultIdFromDek } from "./storage-vault-id.mjs";

const OBJECTS = "objects";

/**
 * @param {string} filePath
 */
function fileContentFingerprint(filePath) {
  const body = fs.readFileSync(filePath);
  return {
    size: body.length,
    hash: crypto.createHash("sha256").update(body).digest("hex"),
  };
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyFileWithFsync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (fs.existsSync(dest)) {
    const srcFp = fileContentFingerprint(src);
    const destFp = fileContentFingerprint(dest);
    if (srcFp.hash === destFp.hash && srcFp.size === destFp.size) {
      return;
    }
    throw new StorageError(
      `Migration refuses to overwrite differing bytes at ${path.basename(dest)} (destination already has different content). Remove the destination file or use an empty folder.`,
      "invalid_argument",
    );
  }
  fs.copyFileSync(src, dest);
  const fd = fs.openSync(dest, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
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
 * @param {string} rootDir
 */
function objectsTreeHasRegularFiles(rootDir) {
  const objects = path.join(rootDir, OBJECTS);
  if (!fs.existsSync(objects)) return false;
  return listRegularFilesRecursive(objects).length > 0;
}

/**
 * @param {{
 *   destRoot: string,
 *   vaultId: string,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   resumeState?: Record<string, unknown> | null,
 * }} params
 */
async function assertMigrationDestinationPrecheck(params) {
  if (!objectsTreeHasRegularFiles(params.destRoot)) {
    return;
  }
  const resume =
    params.resumeState &&
    params.resumeState.destRoot === params.destRoot &&
    params.resumeState.vaultId === params.vaultId;
  if (resume) {
    return;
  }
  const adapter = createFolderStorageAdapter({
    rootDir: params.destRoot,
    placeholderTimeoutMs: 80,
    auditReadOnly: true,
  });
  try {
    await adapter.init();
    const manifest = await loadFolderMergedManifest(adapter, params.dek, params.layoutPrefix);
    if (!manifest.devices.length) {
      throw new StorageError("Destination has object files but no readable vault manifest", "invalid_argument");
    }
  } catch (error) {
    if (error instanceof StorageError && error.code === "invalid_argument") {
      throw error;
    }
    throw new StorageError(
      "Destination folder is not empty and does not appear to be the same vault. Use an empty destination or resume an in-progress migration for this vault.",
      "invalid_argument",
    );
  } finally {
    await adapter.close();
  }
}

/**
 * @param {string} sourceRoot
 * @param {string} destRoot
 * @param {Map<string, { size: number, hash: string }>} sourceSnapshot
 */
function mirrorSourceSnapshotToDestination(sourceRoot, destRoot, sourceSnapshot) {
  for (const [relFromSrcRoot, fp] of sourceSnapshot) {
    const srcPath = path.join(sourceRoot, relFromSrcRoot);
    const destPath = path.join(destRoot, relFromSrcRoot);
    if (!fs.existsSync(srcPath)) {
      throw new StorageError(
        `Migration source file removed during final pass (${relFromSrcRoot}). Re-run migrate from a stable source.`,
        "invalid_argument",
      );
    }
    const now = fileContentFingerprint(srcPath);
    if (now.hash !== fp.hash || now.size !== fp.size) {
      throw new StorageError(
        `Migration source changed during final pass (${relFromSrcRoot}). Re-run migrate after the source vault is stable.`,
        "invalid_argument",
      );
    }
    if (fs.existsSync(destPath)) {
      const destFp = fileContentFingerprint(destPath);
      if (destFp.hash === fp.hash && destFp.size === fp.size) {
        continue;
      }
      throw new StorageError(
        `Migration refuses to overwrite differing bytes at ${relFromSrcRoot}. Remove conflicting destination data or use an empty folder.`,
        "invalid_argument",
      );
    }
    copyFileWithFsync(srcPath, destPath);
  }
}

/**
 * @param {string} sourceRoot
 * @param {string} destRoot
 */
function buildSourceObjectsSnapshot(sourceRoot) {
  const srcObjects = path.join(sourceRoot, OBJECTS);
  /** @type {Map<string, { size: number, hash: string }>} */
  const snapshot = new Map();
  for (const abs of listRegularFilesRecursive(srcObjects)) {
    const rel = path.relative(sourceRoot, abs);
    snapshot.set(rel, fileContentFingerprint(abs));
  }
  return snapshot;
}

/**
 * @param {{
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   destRoot: string,
 *   deviceUuid: string,
 * }} options
 */
export async function verifyDestinationFolderVaultLogs(options) {
  const adapter = createFolderStorageAdapter({
    rootDir: options.destRoot,
    placeholderTimeoutMs: 80,
    auditReadOnly: true,
  });
  await adapter.init();
  try {
    const manifest = await loadFolderMergedManifest(adapter, options.dek, options.layoutPrefix);
    await verifyFolderDeviceLogsChainOnly(
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
    return manifest;
  } finally {
    await adapter.close();
  }
}

/**
 * Final copy + source stability check + destination log verify.
 *
 * @param {{
 *   sourceRoot: string,
 *   destRoot: string,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid: string,
 * }} options
 */
export async function runMigrationFinalPass(options) {
  const snapshotStart = buildSourceObjectsSnapshot(options.sourceRoot);
  if (typeof options.afterInitialSnapshot === "function") {
    options.afterInitialSnapshot();
  }
  mirrorSourceSnapshotToDestination(options.sourceRoot, options.destRoot, snapshotStart);
  const snapshotEnd = buildSourceObjectsSnapshot(options.sourceRoot);
  for (const [rel, fpStart] of snapshotStart) {
    const fpEnd = snapshotEnd.get(rel);
    if (!fpEnd || fpEnd.hash !== fpStart.hash || fpEnd.size !== fpStart.size) {
      throw new StorageError(
        `Migration source changed during final pass (${rel}). Re-run migrate after the source vault is stable.`,
        "invalid_argument",
      );
    }
  }
  for (const [rel, fpEnd] of snapshotEnd) {
    const destPath = path.join(options.destRoot, rel);
    if (!fs.existsSync(destPath)) {
      throw new StorageError(
        `Migration destination missing ${rel} after final copy pass`,
        "invalid_argument",
      );
    }
    const destFp = fileContentFingerprint(destPath);
    if (destFp.hash !== fpEnd.hash || destFp.size !== fpEnd.size) {
      throw new StorageError(
        `Migration destination does not match source for ${rel} after final pass`,
        "invalid_argument",
      );
    }
  }
  await verifyDestinationFolderVaultLogs(options);
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
 * @param {string} scopeKey
 * @param {{
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   sourceRoot: string,
 *   destRoot: string,
 *   deviceUuid: string,
 *   maxCopyFiles?: number,
 *   applyConfig?: boolean,
 *   afterInitialSnapshot?: () => void,
 * }} options
 */
export async function runStorageMigrateLocalToFolder(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const destRoot = path.resolve(options.destRoot);
  const scopeKey = options.scopeKey ?? `${sourceRoot}->${destRoot}`;
  const vaultId = storageVaultIdFromDek(options.dek);
  const srcObjects = path.join(sourceRoot, OBJECTS);
  if (!fs.existsSync(srcObjects)) {
    throw new StorageError(`Local migrate source missing ${OBJECTS}/`, "invalid_argument");
  }

  let state = loadStorageMigrateState(scopeKey);
  await assertMigrationDestinationPrecheck({
    destRoot,
    vaultId,
    dek: options.dek,
    layoutPrefix: options.layoutPrefix,
    resumeState: state,
  });

  initFolderStorageRoot(destRoot);

  if (!state || state.sourceRoot !== sourceRoot || state.destRoot !== destRoot || state.vaultId !== vaultId) {
    state = {
      sourceRoot,
      destRoot,
      vaultId,
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
    copyFileWithFsync(abs, destPath);
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

  const finalizeParams = {
    sourceRoot,
    destRoot,
    dek: options.dek,
    layoutPrefix: options.layoutPrefix,
    deviceUuid: options.deviceUuid,
    afterInitialSnapshot: options.afterInitialSnapshot,
  };

  if (options.applyConfig) {
    await runMigrationFinalPass(finalizeParams);
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
    state.verified = true;
    state.configApplied = true;
    saveStorageMigrateState(scopeKey, state);
    return {
      phase: "config_applied",
      copiedCount: copiedSet.size,
      verified: true,
      configApplied: true,
    };
  }

  if (!state.verified) {
    await runMigrationFinalPass(finalizeParams);
    state.verified = true;
    saveStorageMigrateState(scopeKey, state);
  }

  return {
    phase: state.configApplied ? "config_applied" : "verified",
    copiedCount: copiedSet.size,
    verified: true,
    configApplied: Boolean(state.configApplied),
  };
}
