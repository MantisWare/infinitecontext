import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { initFolderStorageRoot } from "../../lib/storage/storage-init.mjs";
import {
  loadStorageMigrateState,
  runStorageMigrateLocalToFolder,
  storageMigrateStatePath,
} from "../../lib/storage/storage-migrate-local-folder.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";

const DEK = new Uint8Array(32).fill(61);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "accounts/local";

async function seedLocalVault(localRoot) {
  const adapter = createFilesystemStorageAdapter({ rootDir: localRoot });
  await adapter.init();
  const localState = createCliFileObjectStoreLocalState(
    path.join(localRoot, "sync-state.json"),
  );
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
        payload: { metadata: { tag: "migrate-seed" } },
      },
    ],
  );
  await adapter.close();
}

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
  });
});
