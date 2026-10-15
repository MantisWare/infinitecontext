import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import {
  createCliFileObjectStoreLocalState,
  createDaemonDbObjectStoreLocalState,
} from "../../lib/object-store-local-state-persist.mjs";
import { writeConfigFile, readConfigFile } from "../../lib/client-config.mjs";
import { LOCAL_OBJECT_STORE_BACKEND_ID } from "../../lib/storage/local-object-store.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "../../lib/storage/folder-adapter.mjs";
import {
  clearStorageCliDepsForTests,
  setStorageCliDepsForTests,
} from "../../lib/storage-cli-deps.mjs";
import { objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { initFolderStorageRoot } from "../../lib/storage/storage-init.mjs";
import {
  cleanupMigrationTempCopyFiles,
  loadStorageMigrateState,
  migrationCopyFileWithFsync,
  MIGRATION_COPY_TMP_BASENAME_PREFIX,
  resetStorageMigrate,
  isMigrationResetProtectedRelativePath,
  runStorageMigrateLocalToFolder,
  saveStorageMigrateState,
  storageMigrateStatePath,
} from "../../lib/storage/storage-migrate-local-folder.mjs";
import { resolveObjectStoreTrustBindingKey } from "../../lib/object-store-sync-binding.mjs";
import { auditFolderObjectStoreVault } from "../../lib/storage/storage-doctor.mjs";
import { deriveDevH, logSegmentRelativePath } from "../../lib/storage/layout.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { assertLocalObjectStoreRootNotSynced } from "../../lib/storage/sync-root-guard.mjs";
const DEK = new Uint8Array(32).fill(61);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "accounts/local";

describe("Phase 4.5 storage CLI (#9)", () => {
  describe("storage init", () => {
    it("refuses a symlinked folder root", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-init-sym-"));
      const target = path.join(root, "target");
      const link = path.join(root, "link");
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.symlinkSync(target, link, "dir");
      assert.throws(() => initFolderStorageRoot(link), (err) => err instanceof StorageError);
    });

    it("creates objects/ under a new folder root", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-init-new-"));
      initFolderStorageRoot(root);
      assert.ok(fs.existsSync(path.join(root, "objects")));
    });

    it("allows init under a desktop-sync marker path (folder backend)", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-init-sync-"));
      fs.mkdirSync(path.join(root, ".dropbox"));
      initFolderStorageRoot(root);
      assert.ok(fs.existsSync(path.join(root, "objects")));
    });

    it("local backend guard refuses synced roots", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-local-sync-"));
      fs.mkdirSync(path.join(root, ".dropbox"));
      assert.throws(() => assertLocalObjectStoreRootNotSynced(root), (err) => err instanceof StorageError);
    });
  });

  describe("storage migrate local → folder", () => {
    const scopeKey = "pr9-test-migrate";

    afterEach(() => {
      try {
        fs.unlinkSync(storageMigrateStatePath(scopeKey));
      } catch {
        /* ignore */
      }
    });

    it("copies objects, verifies logs, never deletes source; resumes after interrupt", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const srcObjects = path.join(localRoot, "objects");
      assert.ok(fs.existsSync(srcObjects));

      const first = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
        maxCopyFiles: 1,
      });
      assert.equal(first.phase, "copying");
      assert.ok(first.copiedCount >= 1);
      assert.ok(fs.existsSync(srcObjects));

      const second = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      assert.equal(second.phase, "verified");
      assert.ok(fs.existsSync(srcObjects));
      const state = loadStorageMigrateState(scopeKey);
      assert.equal(state.verified, true);
      assert.ok(fs.existsSync(path.join(folderRoot, "objects")));
    });

    it("refuses a non-empty destination that is not the same vault", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-src2-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst2-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const otherDek = new Uint8Array(32).fill(99);
      await seedLocalVault(folderRoot, otherDek);
      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey: `${scopeKey}-vault-mismatch`,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
          }),
        (err) => err instanceof StorageError && err.code === "invalid_argument",
      );
    });

    it("refuses migrate --apply-config when source store is behind local trusted heads (log_rollback)", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-rollback-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-rollback-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      await inflateLocalTrustAheadOfStore(syncStatePath, localRoot, LOCAL_OBJECT_STORE_BACKEND_ID);
      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey: `${scopeKey}-rollback`,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
            applyConfig: true,
          }),
        (err) => err instanceof StorageError && err.code === "log_rollback",
      );
    });

    it("resumes and re-mirrors when source changes after an earlier copy (recorded hashes)", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-resume-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-resume-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-resume-hash`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const adapter = createFilesystemStorageAdapter({ rootDir: localRoot });
      await adapter.init();
      const localState = createCliFileObjectStoreLocalState(syncStatePath);
      await objectStorePushSyncMutations(
        {
          adapter,
          dek: DEK,
          layoutPrefix: PREFIX,
          selfDevH: deriveDevH(DEK, DEVICE_A),
          deviceUuid: DEVICE_A,
          localState,
        },
        [
          {
            client_id: generateClientNodeId(),
            op: "context_create",
            payload: { metadata: { tag: "post-migrate-append" } },
          },
        ],
      );
      await adapter.close();
      const again = await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      assert.equal(again.phase, "verified");
    });

    it("refuses resume when destination vault identity changed", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-id-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-id-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-dest-id`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const state = loadStorageMigrateState(sk);
      state.destStoreIdentity = "0:FAKE";
      saveStorageMigrateState(sk, state);
      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey: sk,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
          }),
        (err) => err instanceof StorageError && /identity changed/i.test(String(err.message)),
      );
    });

    it("N5: atomic copy leaves no migration temp files and resumes after stray temps", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-atomic-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-atomic-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const srcFile = listObjectFiles(localRoot).find((p) => p.endsWith(".icgen"));
      assert.ok(srcFile);
      const sk = `${scopeKey}-atomic`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const destRel = path.relative(localRoot, srcFile);
      const destPath = path.join(folderRoot, destRel);
      const strayTmp = path.join(
        path.dirname(destPath),
        `${MIGRATION_COPY_TMP_BASENAME_PREFIX}9999-deadbeef.tmp`,
      );
      fs.copyFileSync(srcFile, strayTmp);
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      assert.ok(fs.existsSync(destPath));
      const tempsLeft = listObjectFiles(folderRoot).filter((p) =>
        path.basename(p).startsWith(MIGRATION_COPY_TMP_BASENAME_PREFIX),
      );
      assert.deepEqual(tempsLeft, []);
      assert.equal(cleanupMigrationTempCopyFiles(folderRoot), 0);
    });

    it("storage migrate --reset deletes only fingerprint-matching copies and never manifest/devices", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-reset-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-reset-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-reset`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const state = loadStorageMigrateState(sk);
      assert.ok(state.copiedRelativePaths.length >= 1);
      const manifestRel = state.copiedRelativePaths.find((rel) =>
        isMigrationResetProtectedRelativePath(rel, PREFIX),
      );
      assert.ok(manifestRel, "expected manifest or devices path in copied set");
      const removed = resetStorageMigrate(sk, { layoutPrefix: PREFIX });
      assert.ok(removed.removed >= 1);
      assert.ok(removed.skipped >= 1);
      assert.ok(fs.existsSync(path.join(folderRoot, manifestRel)));
      assert.equal(loadStorageMigrateState(sk), null);
    });

    it("storage migrate --reset is refused after --apply-config or when config points at dest", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-reset-ref-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-reset-ref-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-reset-refused`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
        applyConfig: true,
      });
      const applied = loadStorageMigrateState(sk);
      assert.equal(applied.configApplied, true);
      assert.throws(
        () => resetStorageMigrate(sk, { layoutPrefix: PREFIX }),
        (err) => err instanceof StorageError && /refused after `--apply-config`/i.test(err.message),
      );
      const folderRootLive = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-reset-live-d-"));
      initFolderStorageRoot(folderRootLive);
      const sk2 = `${scopeKey}-reset-config-live`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk2,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRootLive,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      writeConfigFile({
        storage: { backend: "folder", folder: { path: folderRootLive }, deviceUuid: DEVICE_A },
      });
      assert.throws(
        () => resetStorageMigrate(sk2, { config: readConfigFile(), layoutPrefix: PREFIX }),
        (err) =>
          err instanceof StorageError && /refused while `config\.json` points/i.test(err.message),
      );
    });

    it("refuses to overwrite differing destination bytes", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-src3-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst3-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-overwrite`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const relKey = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(folderRoot, relKey);
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      const destFile = path.join(keyDir, gen);
      const buf = fs.readFileSync(destFile);
      buf[0] ^= 0x01;
      fs.writeFileSync(destFile, buf);
      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey: sk,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
            applyConfig: true,
          }),
        (err) =>
          err instanceof StorageError &&
          err.code === "invalid_argument" &&
          /refuses to overwrite/i.test(err.message),
      );
    });

    it("refuses when source changes during final pass", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-src4-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst4-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-drift`;
      const icgenPath = listObjectFiles(localRoot).find((p) => p.endsWith(".icgen"));
      assert.ok(icgenPath);
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey: sk,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
            applyConfig: true,
            afterInitialSnapshot: () => {
              const buf = fs.readFileSync(icgenPath);
              buf[buf.length - 1] ^= 0x0f;
              fs.writeFileSync(icgenPath, buf);
            },
          }),
        (err) =>
          err instanceof StorageError &&
          /source changed during final pass/i.test(String(err.message)),
      );
    });

    it("--apply-config re-verifies even when state.verified is true (truncated dest)", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-src5-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst5-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const sk = `${scopeKey}-apply-trust`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const state = loadStorageMigrateState(sk);
      assert.equal(state.verified, true);
      state.verified = true;
      saveStorageMigrateState(sk, state);
      const relKey = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const destKeyDir = objectKeyDirectory(folderRoot, relKey).keyDir;
      const gen = fs.readdirSync(destKeyDir).find((n) => n.endsWith(".icgen"));
      const destFile = path.join(destKeyDir, gen);
      const buf = fs.readFileSync(destFile);
      buf[buf.length - 2] ^= 0x7;
      fs.writeFileSync(destFile, buf);
      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey: sk,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
            applyConfig: true,
          }),
        (err) => err instanceof StorageError,
      );
    });
  });

  describe("storage doctor audit", () => {
    it("reports ok:true on a healthy copied folder vault", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-dst-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-ok",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      await adapter.close();
      assert.equal(report.ok, true);
      assert.equal(report.logVerify.ok, true);
    });

    it("does not mutate folder root mtime in auditReadOnly init", async () => {
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-mtime-"));
      initFolderStorageRoot(folderRoot);
      const mtimeBefore = fs.statSync(folderRoot).mtimeMs;
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      await adapter.close();
      assert.equal(fs.statSync(folderRoot).mtimeMs, mtimeBefore);
    });

    it("reports heads_unverified when no trusted heads exist", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-unver-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-unver-d-"));
      initFolderStorageRoot(folderRoot);
      const emptyTrust = path.join(localRoot, "missing-trust.json");
      const { syncStatePath } = await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-unver",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        deviceUuid: DEVICE_A,
        cliStatePath: emptyTrust,
      });
      await adapter.close();
      assert.equal(report.ok, false);
      assert.equal(report.logVerify.status, "heads_unverified");
    });

    it("reports log_rollback when folder store is behind local trusted heads", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-rb-src-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-rb-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-rb",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      await inflateLocalTrustAheadOfStore(syncStatePath, folderRoot, FOLDER_STORAGE_ADAPTER_ID);
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      await adapter.close();
      assert.equal(report.ok, false);
      assert.equal(report.logVerify.code, "log_rollback");
    });

    it("returns full audit JSON when conflict copies exist (no throw)", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-conf-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-conf-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-conf",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(folderRoot, key);
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      const alt = path.join(keyDir, gen.replace(".icgen", " 2.icgen"));
      fs.copyFileSync(path.join(keyDir, gen), alt);
      const buf = fs.readFileSync(alt);
      buf[buf.length - 4] ^= 0x55;
      fs.writeFileSync(alt, buf);
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      await adapter.close();
      assert.equal(report.ok, false);
      assert.ok(report.preflight);
      assert.match(String(report.preflight?.message ?? ""), /fork|conflict|Resolve manually/i);
    });

    it("reports manifest generation conflict copies (2.icgen)", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-mconf-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-mconf-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-mconf",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      const manifestKey = `${PREFIX}/ic-v1/manifest.json.enc`;
      const { keyDir } = objectKeyDirectory(folderRoot, manifestKey);
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      const alt = path.join(keyDir, gen.replace(".icgen", " 2.icgen"));
      fs.copyFileSync(path.join(keyDir, gen), alt);
      const buf = fs.readFileSync(alt);
      buf[buf.length - 4] ^= 0x33;
      fs.writeFileSync(alt, buf);
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      await adapter.close();
      assert.equal(report.ok, false);
      assert.ok(report.preflight);
      assert.match(String(report.preflight?.message ?? ""), /manifest\.json\.enc|2\.icgen/i);
    });
  });

  describe("storage CLI daemon.db trust wiring (B1)", () => {
    /** @type {string | undefined} */
    let priorDbFileEnv;

    afterEach(() => {
      clearStorageCliDepsForTests();
      if (priorDbFileEnv === undefined) {
        delete process.env.INFINITECONTEXT_DB_FILE;
      } else {
        process.env.INFINITECONTEXT_DB_FILE = priorDbFileEnv;
      }
    });

    it("real CLI doctor catches folder rollback using daemon.db trust only", async () => {
      priorDbFileEnv = process.env.INFINITECONTEXT_DB_FILE;
      const daemonDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-db-")), "daemon.db");
      process.env.INFINITECONTEXT_DB_FILE = daemonDbPath;
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-daemon-rb-"));
      initFolderStorageRoot(folderRoot);
      writeConfigFile({
        baseUrl: "http://127.0.0.1:9",
        storage: { backend: "folder", folder: { path: folderRoot }, deviceUuid: DEVICE_A },
      });
      const { syncStatePath } = await seedLocalVault(folderRoot);
      await copyCliTrustIntoDaemonDb(syncStatePath, daemonDbPath);
      await inflateDaemonTrustAheadOfStore(daemonDbPath, folderRoot, FOLDER_STORAGE_ADAPTER_ID);
      try {
        fs.unlinkSync(syncStatePath);
      } catch {
        /* ignore */
      }
      setStorageCliDepsForTests({
        resolveUnlockedDek: async () => ({ dek: DEK }),
      });
      const report = await runStorageDoctorCliJson();
      assert.equal(report.ok, false);
      assert.equal(report.logVerify.code, "log_rollback");
    });

    it("real CLI doctor does not report heads_unverified when only daemon.db has trusted heads", async () => {
      priorDbFileEnv = process.env.INFINITECONTEXT_DB_FILE;
      const daemonDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-db-")), "daemon.db");
      process.env.INFINITECONTEXT_DB_FILE = daemonDbPath;
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-daemon-ok-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-daemon-ok-d-"));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-cli-daemon-heads",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
      });
      writeConfigFile({
        baseUrl: "http://127.0.0.1:9",
        storage: { backend: "folder", folder: { path: folderRoot }, deviceUuid: DEVICE_A },
      });
      await copyCliTrustIntoDaemonDb(syncStatePath, daemonDbPath);
      try {
        fs.unlinkSync(syncStatePath);
      } catch {
        /* ignore */
      }
      setStorageCliDepsForTests({
        resolveUnlockedDek: async () => ({ dek: DEK }),
      });
      const report = await runStorageDoctorCliJson();
      assert.equal(report.ok, true);
      assert.notEqual(report.logVerify.status, "heads_unverified");
    });
  });
});

async function runStorageDoctorCliJson() {
  /** @type {string[]} */
  const lines = [];
  const prior = console.log;
  console.log = (value) => {
    lines.push(String(value));
    prior(value);
  };
  try {
    const { runStorageCli } = await import("../../src/cli/storage-cli.mjs");
    await runStorageCli("doctor", []);
    const raw = lines.at(-1);
    assert.ok(raw, "expected doctor JSON on stdout");
    return JSON.parse(raw);
  } finally {
    console.log = prior;
  }
}

async function copyCliTrustIntoDaemonDb(cliStatePath, daemonDbPath) {
  const cli = createCliFileObjectStoreLocalState(cliStatePath).load();
  fs.mkdirSync(path.dirname(daemonDbPath), { recursive: true, mode: 0o700 });
  const daemon = createDaemonDbObjectStoreLocalState(daemonDbPath);
  try {
    await daemon.save(cli);
  } finally {
    daemon.close();
  }
}

/**
 * @param {string} daemonDbPath
 * @param {string} storeRoot
 * @param {string} backendId
 */
async function inflateDaemonTrustAheadOfStore(daemonDbPath, storeRoot, backendId) {
  const daemon = createDaemonDbObjectStoreLocalState(daemonDbPath);
  const state = daemon.load();
  const devH = deriveDevH(DEK, DEVICE_A).toUpperCase();
  state.trustedHeads[devH] = { seq: 8, digest: "f".repeat(64) };
  const bindingKey = resolveObjectStoreTrustBindingKey(storeRoot, backendId);
  state.manifestGenerationHighWaterByBindingKey = {
    ...(state.manifestGenerationHighWaterByBindingKey ?? {}),
    [bindingKey]: 99,
  };
  try {
    await daemon.save(state);
  } finally {
    daemon.close();
  }
}

async function seedLocalVault(localRoot, dek = DEK) {
  const adapter = createFilesystemStorageAdapter({ rootDir: localRoot });
  await adapter.init();
  const localState = createCliFileObjectStoreLocalState(
    path.join(localRoot, "sync-state.json"),
  );
  await objectStorePushSyncMutations(
    {
      adapter,
      dek,
      layoutPrefix: PREFIX,
      selfDevH: deriveDevH(dek, DEVICE_A),
      deviceUuid: DEVICE_A,
      localState,
    },
    [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "migrate-seed" } },
      },
    ],
  );
  await adapter.close();
  return { syncStatePath: path.join(localRoot, "sync-state.json") };
}

/**
 * @param {string} syncStatePath
 * @param {string} storeRoot
 */
async function inflateLocalTrustAheadOfStore(syncStatePath, storeRoot, backendId) {
  const localState = createCliFileObjectStoreLocalState(syncStatePath);
  const state = localState.load();
  const devH = deriveDevH(DEK, DEVICE_A).toUpperCase();
  state.trustedHeads[devH] = { seq: 8, digest: "f".repeat(64) };
  const bindingKey = resolveObjectStoreTrustBindingKey(storeRoot, backendId);
  state.manifestGenerationHighWaterByBindingKey = {
    ...(state.manifestGenerationHighWaterByBindingKey ?? {}),
    [bindingKey]: 99,
  };
  await localState.save(state);
}

/**
 * @param {string} storeRoot
 */
function listObjectFiles(storeRoot) {
  const objects = path.join(storeRoot, "objects");
  /** @type {string[]} */
  const out = [];
  const walk = (cursor) => {
    for (const ent of fs.readdirSync(cursor, { withFileTypes: true })) {
      const full = path.join(cursor, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  walk(objects);
  return out;
}
