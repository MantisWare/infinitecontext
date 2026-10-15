import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { initFolderStorageRoot } from "../../lib/storage/storage-init.mjs";
import {
  cleanupMigrationTempCopyFiles,
  MIGRATION_COPY_TMP_BASENAME_PREFIX,
  runStorageMigrateLocalToFolder,
  storageMigrateStatePath,
} from "../../lib/storage/storage-migrate-local-folder.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

const DEK = new Uint8Array(32).fill(61);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "accounts/local";
const scopeKey = "migrate-resume-suite";

async function seedLocalVault(localRoot) {
  const adapter = createFilesystemStorageAdapter({ rootDir: localRoot });
  await adapter.init();
  const localState = createCliFileObjectStoreLocalState(path.join(localRoot, "sync-state.json"));
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
        payload: { metadata: { tag: "resume-seed" } },
      },
    ],
  );
  await adapter.close();
  return { syncStatePath: path.join(localRoot, "sync-state.json") };
}

describe("storage migrate resume (partial copy)", () => {
  afterEach(() => {
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }
  });

  for (const k of [1, 2, 3, 4, 5]) {
    it(`resumes to verified after stopping at maxCopyFiles=${k}`, async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-k${k}-src-`));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-k${k}-dst-`));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedLocalVault(localRoot);
      const first = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
        maxCopyFiles: k,
      });
      assert.equal(first.phase, "copying");
      assert.ok(first.copiedCount >= k);
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
    });
  }

  it("t2: copy/state SIGKILL loops recover across repeated partial runs", async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-resume-t2-src-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-dst2-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedLocalVault(localRoot);
    for (let loop = 0; loop < 3; loop += 1) {
      const partial = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
        maxCopyFiles: 1 + loop,
      });
      if (partial.phase === "verified") {
        break;
      }
      assert.equal(partial.phase, "copying");
    }
    const done = await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
    });
    assert.equal(done.phase, "verified");
  });

  it("resumes after a stray migration temp file (SIGKILL-style interrupt)", async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-resume-kill-src-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-resume-kill-dst-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedLocalVault(localRoot);
    await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
      maxCopyFiles: 2,
    });
    const objects = path.join(folderRoot, "objects");
    const walk = (cursor) => {
      for (const ent of fs.readdirSync(cursor, { withFileTypes: true })) {
        const full = path.join(cursor, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name.endsWith(".icgen")) {
          const stray = path.join(
            path.dirname(full),
            `${MIGRATION_COPY_TMP_BASENAME_PREFIX}9999-deadbeef.tmp`,
          );
          fs.copyFileSync(full, stray);
          return;
        }
      }
    };
    walk(objects);
    assert.ok(cleanupMigrationTempCopyFiles(folderRoot) >= 0);
    const done = await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
    });
    assert.equal(done.phase, "verified");
  });
});
