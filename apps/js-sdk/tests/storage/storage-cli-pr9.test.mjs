import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { initFolderStorageRoot } from "../../lib/storage/storage-init.mjs";
import {
  loadStorageMigrateState,
  runStorageMigrateLocalToFolder,
  saveStorageMigrateState,
  storageMigrateStatePath,
} from "../../lib/storage/storage-migrate-local-folder.mjs";
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
      await seedLocalVault(localRoot);
      const srcObjects = path.join(localRoot, "objects");
      assert.ok(fs.existsSync(srcObjects));

      const first = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
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
      await seedLocalVault(localRoot);
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
          }),
        (err) => err instanceof StorageError && err.code === "invalid_argument",
      );
    });

    it("refuses to overwrite differing destination bytes", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-src3-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst3-"));
      initFolderStorageRoot(folderRoot);
      await seedLocalVault(localRoot);
      const sk = `${scopeKey}-overwrite`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
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
      await seedLocalVault(localRoot);
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
      await seedLocalVault(localRoot);
      const sk = `${scopeKey}-apply-trust`;
      await runStorageMigrateLocalToFolder({
        scopeKey: sk,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
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
      await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-ok",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
      });
      const adapter = createFolderStorageAdapter({ rootDir: folderRoot, auditReadOnly: true });
      await adapter.init();
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        deviceUuid: DEVICE_A,
      });
      await adapter.close();
      assert.equal(report.ok, true);
      assert.equal(report.logVerify.ok, true);
    });

    it("returns full audit JSON when conflict copies exist (no throw)", async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-conf-"));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-conf-d-"));
      initFolderStorageRoot(folderRoot);
      await seedLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey: "pr9-doctor-conf",
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
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
      });
      await adapter.close();
      assert.equal(report.ok, false);
      assert.ok(report.preflight);
      assert.match(String(report.preflight?.message ?? ""), /fork|conflict|Resolve manually/i);
    });
  });
});

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
