import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { infinitecontextHome } from "../client-config.mjs";
import { readConfigFile, writeConfigFile } from "../client-config.mjs";
import { LOCAL_OBJECT_STORE_BACKEND_ID } from "./local-object-store.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./folder-adapter.mjs";
import { resolveFolderObjectStoreRootDir } from "./folder-object-store.mjs";
import { isFolderObjectStoreBackend } from "../sync-storage-backend.mjs";
import { storagePathsReferToSameLocationOrUnresolvable } from "./storage-path-compare.mjs";
import { createFolderStorageAdapter } from "./folder-adapter.mjs";
import { createFilesystemStorageAdapter } from "./filesystem-adapter.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";
import { initFolderStorageRoot } from "./storage-init.mjs";
import { StorageError } from "./errors.mjs";
import { deriveDevH } from "./layout.mjs";
import { storageVaultIdFromDek } from "./storage-vault-id.mjs";
import {
  assertVaultStoreTrustOrThrow,
  auditVaultStoreTrust,
  computeFolderStoreIdentity,
} from "./storage-vault-trust-audit.mjs";

const OBJECTS = "objects";

/** Migration copy temp files: `<dir>/.ic-migrate-copy.<pid>-<hex>.tmp` */
export const MIGRATION_COPY_TMP_BASENAME_PREFIX = ".ic-migrate-copy.";

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
 * @param {string} dirPath
 */
function fsyncDirectory(dirPath) {
  const fd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} destDir
 */
function migrationCopyTempPath(destDir) {
  return path.join(
    destDir,
    `${MIGRATION_COPY_TMP_BASENAME_PREFIX}${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
}

/**
 * @param {string} src
 * @param {string} dest
 */
function atomicCopySourceToDestinationPath(src, dest) {
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const tmp = migrationCopyTempPath(destDir);
  try {
    fs.copyFileSync(src, tmp);
    const fd = fs.openSync(tmp, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, dest);
    fsyncDirectory(destDir);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp removed by rename or never created */
    }
  }
}

/**
 * @param {string} destRoot
 */
export function cleanupMigrationTempCopyFiles(destRoot) {
  const objects = path.join(destRoot, OBJECTS);
  if (!fs.existsSync(objects)) return 0;
  let removed = 0;
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
        const base = ent.name;
        if (base.startsWith(MIGRATION_COPY_TMP_BASENAME_PREFIX) && base.endsWith(".tmp")) {
          fs.unlinkSync(full);
          removed += 1;
        }
      }
    }
  };
  walk(objects);
  return removed;
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {{ recorded?: { size: number, hash: string } | null }} [options]
 */
export function migrationCopyFileWithFsync(src, dest, options = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const srcFp = fileContentFingerprint(src);
  if (fs.existsSync(dest)) {
    const destFp = fileContentFingerprint(dest);
    if (srcFp.hash === destFp.hash && srcFp.size === destFp.size) {
      return srcFp;
    }
    const recorded = options.recorded;
    if (recorded && destFp.hash === recorded.hash && destFp.size === recorded.size) {
      atomicCopySourceToDestinationPath(src, dest);
      return srcFp;
    }
    throw new StorageError(
      `Migration refuses to overwrite differing bytes at ${path.basename(dest)}. Re-run after source stabilizes, or use \`storage migrate --reset\` to restart cleanly.`,
      "invalid_argument",
    );
  }
  atomicCopySourceToDestinationPath(src, dest);
  return srcFp;
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
        const base = ent.name;
        if (base.startsWith(MIGRATION_COPY_TMP_BASENAME_PREFIX) && base.endsWith(".tmp")) {
          continue;
        }
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
/**
 * @param {string} relFromStoreRoot path relative to store root (includes `objects/…`)
 * @param {string} layoutPrefix
 */
export function isMigrationResetProtectedRelativePath(relFromStoreRoot, layoutPrefix) {
  const normalized = String(relFromStoreRoot).replace(/\\/g, "/");
  const vaultPrefix = `${OBJECTS}/${layoutPrefix}/ic-v1/`;
  if (!normalized.startsWith(vaultPrefix)) {
    return false;
  }
  const suffix = normalized.slice(vaultPrefix.length);
  if (suffix === "vault.json") {
    return true;
  }
  if (suffix === "manifest.json.enc" || suffix.startsWith("manifest.json.enc/")) {
    return true;
  }
  if (suffix.startsWith("devices/")) {
    return true;
  }
  return false;
}

/**
 * @param {{
 *   scopeKey: string,
 *   state: Record<string, unknown>,
 *   destRoot: string,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   allowRecord?: boolean,
 * }} params
 */
async function recordAndAssertMigrationDestinationIdentity(params) {
  const objects = path.join(params.destRoot, OBJECTS);
  if (!fs.existsSync(objects) || !objectsTreeHasRegularFiles(params.destRoot)) {
    return;
  }
  const recorded = params.state.destStoreIdentity ? String(params.state.destStoreIdentity) : null;
  if (!recorded && !params.allowRecord) {
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
    const identity = computeFolderStoreIdentity(manifest);
    if (recorded && recorded !== identity) {
      throw new StorageError(
        "Destination vault identity changed since migration started; use an empty folder or `storage migrate --reset`",
        "invalid_argument",
      );
    }
    if (!recorded && params.allowRecord) {
      params.state.destStoreIdentity = identity;
      saveStorageMigrateState(params.scopeKey, params.state);
    }
  } finally {
    await adapter.close();
  }
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | null} destRoot
 */
function activeConfigPointsAtMigrationDest(config, destRoot, env = process.env) {
  if (!destRoot || !isFolderObjectStoreBackend(config)) {
    return false;
  }
  try {
    const configFolder = resolveFolderObjectStoreRootDir(config, env);
    return storagePathsReferToSameLocationOrUnresolvable(configFolder, destRoot);
  } catch {
    return true;
  }
}

const MIGRATION_DEST_IDENTITY_CHECK_EVERY_N = 8;

async function assertMigrationDestinationPrecheck(params) {
  if (!objectsTreeHasRegularFiles(params.destRoot)) {
    return;
  }
  const adapter = createFolderStorageAdapter({
    rootDir: params.destRoot,
    placeholderTimeoutMs: 80,
    auditReadOnly: true,
  });
  try {
    await adapter.init();
    const resume = params.resumeState;
    if (resume && resume.vaultId === params.vaultId) {
      if (resume.destStoreIdentity) {
        const manifest = await loadFolderMergedManifest(adapter, params.dek, params.layoutPrefix);
        const identity = computeFolderStoreIdentity(manifest);
        if (resume.destStoreIdentity !== identity) {
          throw new StorageError(
            "Destination vault identity changed since migration started; use an empty folder or `storage migrate --reset`",
            "invalid_argument",
          );
        }
      }
      return;
    }
    const manifest = await loadFolderMergedManifest(adapter, params.dek, params.layoutPrefix);
    if (!manifest.devices.length) {
      throw new StorageError("Destination has object files but no readable vault manifest", "invalid_argument");
    }
    if (!resume || resume.vaultId !== params.vaultId) {
      throw new StorageError(
        "Destination folder is not empty. Use an empty destination, resume an in-progress migration for this vault, or `storage migrate --reset` to restart cleanly.",
        "invalid_argument",
      );
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
 * @param {Record<string, { size: number, hash: string }>} recordedByRel
 */
function mirrorSourceSnapshotToDestination(sourceRoot, destRoot, sourceSnapshot, recordedByRel) {
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
    migrationCopyFileWithFsync(srcPath, destPath, { recorded: recordedByRel[relFromSrcRoot] ?? null });
  }
}

/**
 * @param {string} sourceRoot
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
 *   sourceRoot: string,
 *   destRoot: string,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid: string,
 *   cliStatePath?: string,
 *   daemonDbPath?: string,
 * }} options
 */
async function assertSourceVaultTrustBeforeFinalize(options) {
  const adapter = createFilesystemStorageAdapter({
    rootDir: options.sourceRoot,
    auditReadOnly: true,
  });
  await adapter.init();
  try {
    await assertVaultStoreTrustOrThrow({
      adapter,
      dek: options.dek,
      layoutPrefix: options.layoutPrefix,
      deviceUuid: options.deviceUuid,
      storeRootDir: options.sourceRoot,
      cliStatePath: options.cliStatePath,
      daemonDbPath: options.daemonDbPath,
      backendId: LOCAL_OBJECT_STORE_BACKEND_ID,
    });
  } finally {
    await adapter.close();
  }
}

/**
 * @param {{
 *   destRoot: string,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid: string,
 *   cliStatePath?: string,
 *   daemonDbPath?: string,
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
    const trust = await auditVaultStoreTrust({
      adapter,
      dek: options.dek,
      layoutPrefix: options.layoutPrefix,
      deviceUuid: options.deviceUuid,
      storeRootDir: options.destRoot,
      cliStatePath: options.cliStatePath,
      daemonDbPath: options.daemonDbPath,
      backendId: FOLDER_STORAGE_ADAPTER_ID,
    });
    if (!trust.logVerify.ok) {
      throw new StorageError(
        String(trust.logVerify.error),
        String(trust.logVerify.code ?? trust.logVerify.status ?? "log_rollback"),
      );
    }
    return trust.manifest;
  } finally {
    await adapter.close();
  }
}

/**
 * @param {{
 *   sourceRoot: string,
 *   destRoot: string,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid: string,
 *   cliStatePath?: string,
 *   daemonDbPath?: string,
 *   afterInitialSnapshot?: () => void,
 *   fileFingerprints?: Record<string, { size: number, hash: string }>,
 * }} options
 */
export async function runMigrationFinalPass(options) {
  await assertSourceVaultTrustBeforeFinalize(options);
  const snapshotStart = buildSourceObjectsSnapshot(options.sourceRoot);
  if (typeof options.afterInitialSnapshot === "function") {
    options.afterInitialSnapshot();
  }
  const recorded = options.fileFingerprints ?? {};
  mirrorSourceSnapshotToDestination(options.sourceRoot, options.destRoot, snapshotStart, recorded);
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
  return verifyDestinationFolderVaultLogs(options);
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
 * @param {{ config?: Record<string, unknown>, layoutPrefix?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function resetStorageMigrate(scopeKey, options = {}) {
  const state = loadStorageMigrateState(scopeKey);
  if (!state) return { removed: 0, skipped: 0 };
  const layoutPrefix = options.layoutPrefix ?? "accounts/local";
  const config = options.config ?? readConfigFile();
  const destRoot = state.destRoot ? path.resolve(String(state.destRoot)) : null;

  if (state.configApplied) {
    throw new StorageError(
      "`storage migrate --reset` is refused after `--apply-config` (the destination folder is the live vault)",
      "invalid_argument",
    );
  }
  if (activeConfigPointsAtMigrationDest(config, destRoot, options.env ?? process.env)) {
    throw new StorageError(
      "`storage migrate --reset` is refused while `config.json` points `storage.folder.path` at the migration destination",
      "invalid_argument",
    );
  }

  /** @type {Record<string, { size: number, hash: string }>} */
  const fingerprints =
    state.fileFingerprints && typeof state.fileFingerprints === "object"
      ? /** @type {Record<string, { size: number, hash: string }>} */ (state.fileFingerprints)
      : {};

  let removed = 0;
  let skipped = 0;
  if (destRoot) {
    for (const rel of state.copiedRelativePaths ?? []) {
      if (isMigrationResetProtectedRelativePath(rel, layoutPrefix)) {
        skipped += 1;
        continue;
      }
      const recorded = fingerprints[rel];
      if (!recorded) {
        skipped += 1;
        continue;
      }
      const target = path.join(destRoot, rel);
      if (!fs.existsSync(target)) {
        skipped += 1;
        continue;
      }
      const current = fileContentFingerprint(target);
      if (current.hash !== recorded.hash || current.size !== recorded.size) {
        skipped += 1;
        continue;
      }
      try {
        fs.unlinkSync(target);
        removed += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  try {
    fs.unlinkSync(storageMigrateStatePath(scopeKey));
  } catch {
    /* ignore */
  }
  return { removed, skipped };
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
 *   cliStatePath?: string,
 *   daemonDbPath?: string,
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
  initFolderStorageRoot(destRoot);
  cleanupMigrationTempCopyFiles(destRoot);
  await assertMigrationDestinationPrecheck({
    destRoot,
    vaultId,
    dek: options.dek,
    layoutPrefix: options.layoutPrefix,
    resumeState: state,
  });

  if (!state || state.sourceRoot !== sourceRoot || state.destRoot !== destRoot || state.vaultId !== vaultId) {
    state = {
      sourceRoot,
      destRoot,
      vaultId,
      layoutPrefix: options.layoutPrefix,
      copiedRelativePaths: [],
      fileFingerprints: {},
      verified: false,
      configApplied: false,
    };
    saveStorageMigrateState(scopeKey, state);
  }

  if (state.destStoreIdentity) {
    await recordAndAssertMigrationDestinationIdentity({
      scopeKey,
      state,
      destRoot,
      dek: options.dek,
      layoutPrefix: options.layoutPrefix,
      allowRecord: false,
    });
  }

  /** @type {Record<string, { size: number, hash: string }>} */
  const fileFingerprints =
    state.fileFingerprints && typeof state.fileFingerprints === "object"
      ? /** @type {Record<string, { size: number, hash: string }>} */ (state.fileFingerprints)
      : {};

  const copiedSet = new Set(state.copiedRelativePaths ?? []);
  const allSrcFiles = listRegularFilesRecursive(srcObjects);
  let copiedThisRun = 0;
  let destWritesThisRun = 0;
  const max = options.maxCopyFiles ?? Number.POSITIVE_INFINITY;

  const assertDestinationStableBeforeDestWrite = async () => {
    destWritesThisRun += 1;
    const checkIdentity =
      Boolean(state.destStoreIdentity) &&
      (destWritesThisRun === 1 || destWritesThisRun % MIGRATION_DEST_IDENTITY_CHECK_EVERY_N === 0);
    if (checkIdentity) {
      await recordAndAssertMigrationDestinationIdentity({
        scopeKey,
        state,
        destRoot,
        dek: options.dek,
        layoutPrefix: options.layoutPrefix,
        allowRecord: false,
      });
    }
    if (path.resolve(String(state.destRoot)) !== destRoot) {
      throw new StorageError(
        "Migration destination path changed since migration started",
        "invalid_argument",
      );
    }
  };

  for (const abs of allSrcFiles) {
    const relFromSrcRoot = path.relative(sourceRoot, abs);
    if (copiedSet.has(relFromSrcRoot)) {
      const current = fileContentFingerprint(abs);
      const recorded = fileFingerprints[relFromSrcRoot];
      if (recorded && (recorded.hash !== current.hash || recorded.size !== current.size)) {
        await assertDestinationStableBeforeDestWrite();
        const destPath = path.join(destRoot, relFromSrcRoot);
        migrationCopyFileWithFsync(abs, destPath, { recorded });
        fileFingerprints[relFromSrcRoot] = current;
        state.fileFingerprints = fileFingerprints;
        state.verified = false;
        state.configApplied = false;
        saveStorageMigrateState(scopeKey, state);
      }
      continue;
    }
    if (copiedThisRun >= max) break;
    await assertDestinationStableBeforeDestWrite();
    const destPath = path.join(destRoot, relFromSrcRoot);
    const fp = migrationCopyFileWithFsync(abs, destPath, {
      recorded: fileFingerprints[relFromSrcRoot] ?? null,
    });
    fileFingerprints[relFromSrcRoot] = fp;
    copiedSet.add(relFromSrcRoot);
    copiedThisRun += 1;
    state.copiedRelativePaths = [...copiedSet];
    state.fileFingerprints = fileFingerprints;
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
    cliStatePath: options.cliStatePath,
    daemonDbPath: options.daemonDbPath,
    fileFingerprints,
  };

  if (options.applyConfig) {
    const manifest = await runMigrationFinalPass(finalizeParams);
    state.destStoreIdentity = computeFolderStoreIdentity(manifest);
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
    const manifest = await runMigrationFinalPass(finalizeParams);
    state.destStoreIdentity = computeFolderStoreIdentity(manifest);
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
