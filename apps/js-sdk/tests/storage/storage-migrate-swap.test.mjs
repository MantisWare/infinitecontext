import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { initFolderStorageRoot } from "../../lib/storage/storage-init.mjs";
import {
  loadStorageMigrateState,
  runStorageMigrateLocalToFolder,
  storageMigrateStatePath,
} from "../../lib/storage/storage-migrate-local-folder.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

const DEK = new Uint8Array(32).fill(61);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "accounts/local";

async function seedLocalVault(localRoot, deviceUuid = DEVICE_A) {
  const adapter = createFilesystemStorageAdapter({ rootDir: localRoot });
  await adapter.init();
  const localState = createCliFileObjectStoreLocalState(path.join(localRoot, "sync-state.json"));
  for (let i = 0; i < 8; i += 1) {
    await objectStorePushSyncMutations(
      {
        adapter,
        dek: DEK,
        layoutPrefix: PREFIX,
        selfDevH: deriveDevH(DEK, deviceUuid),
        deviceUuid,
        localState,
      },
      [
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { tag: `seed-${i}` } },
        },
      ],
    );
  }
  await adapter.close();
  return { syncStatePath: path.join(localRoot, "sync-state.json") };
}

function copyObjectsTree(sourceRoot, destRoot) {
  const src = path.join(sourceRoot, "objects");
  const dst = path.join(destRoot, "objects");
  const walk = (relDir) => {
    const srcDir = path.join(src, relDir);
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const rel = path.join(relDir, ent.name);
      const srcPath = path.join(src, rel);
      const dstPath = path.join(dst, rel);
      if (ent.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true, mode: 0o700 });
        walk(rel);
      } else if (ent.isFile()) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true, mode: 0o700 });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  walk("");
}

describe("storage migrate mid-run destination swap", () => {
  for (let n = 1; n <= 23; n += 1) {
    it(`fresh run: foreign swap before destination write ${n} performs 0 further writes`, async () => {
      const scopeKey = `migrate-swap-n${n}`;
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-swap-src-${n}-`));
      const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-swap-fr-${n}-`));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-swap-d-${n}-`));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot, DEVICE_A);
      await seedLocalVault(foreignRoot, DEVICE_B);
      try {
        fs.unlinkSync(storageMigrateStatePath(scopeKey));
      } catch {
        /* ignore */
      }

      await assert.rejects(
        () =>
          runStorageMigrateLocalToFolder({
            scopeKey,
            dek: DEK,
            layoutPrefix: PREFIX,
            sourceRoot: localRoot,
            destRoot: folderRoot,
            deviceUuid: DEVICE_A,
            cliStatePath: syncStatePath,
            testBeforeDestinationWrite: ({ writeNumber }) => {
              if (writeNumber === n) {
                copyObjectsTree(foreignRoot, folderRoot);
              }
            },
          }),
        (err) => err instanceof StorageError && /identity changed/i.test(String(err.message)),
      );

      const after = loadStorageMigrateState(scopeKey);
      assert.equal(after?.copiedRelativePaths?.length ?? 0, n - 1);
      try {
        fs.unlinkSync(storageMigrateStatePath(scopeKey));
      } catch {
        /* ignore */
      }
    });
  }
});
