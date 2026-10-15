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
  loadStorageMigrateState,
  MIGRATION_COPY_TMP_BASENAME_PREFIX,
  runStorageMigrateLocalToFolder,
  storageMigrateStatePath,
} from "../../lib/storage/storage-migrate-local-folder.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

const DEK = new Uint8Array(32).fill(61);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "accounts/local";
const scopeKey = "migrate-resume-suite";

/** Enough pushes for multi-generation device + manifest trees (24 object files). */
const MULTI_GEN_PUSH_COUNT = 8;

/**
 * @param {string} localRoot
 * @param {number} [pushCount]
 */
async function seedMultiGenLocalVault(localRoot, pushCount = MULTI_GEN_PUSH_COUNT) {
  const adapter = createFilesystemStorageAdapter({ rootDir: localRoot });
  await adapter.init();
  const syncStatePath = path.join(localRoot, "sync-state.json");
  const localState = createCliFileObjectStoreLocalState(syncStatePath);
  for (let i = 0; i < pushCount; i += 1) {
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
          payload: { metadata: { tag: `resume-seed-${i}` } },
        },
      ],
    );
  }
  await adapter.close();
  return { syncStatePath };
}

/**
 * @param {string} sourceRoot
 */
function countMigrationSourceObjectFiles(sourceRoot) {
  const objects = path.join(sourceRoot, "objects");
  /** @type {string[]} */
  const out = [];
  const walk = (cursor) => {
    for (const ent of fs.readdirSync(cursor, { withFileTypes: true })) {
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
  walk(objects);
  return out.length;
}

describe("storage migrate resume (partial copy)", () => {
  afterEach(() => {
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }
  });

  for (let k = 1; k <= 23; k += 1) {
    it(`multi-gen: resumes to verified after stopping at maxCopyFiles=${k}`, async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-mg-k${k}-src-`));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-mg-k${k}-dst-`));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedMultiGenLocalVault(localRoot);
      const total = countMigrationSourceObjectFiles(localRoot);
      if (k >= total) {
        return;
      }
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

  for (const k of [1, 3, 8]) {
    it(`t2 copy@${k}: partial then resume completes`, async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-copy${k}-src-`));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-copy${k}-dst-`));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedMultiGenLocalVault(localRoot);
      const partial = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
        maxCopyFiles: k,
      });
      assert.equal(partial.phase, "copying");
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
  }

  for (const k of [1, 2, 5]) {
    it(`t2 state@${k}: SIGKILL-style stop after state save then resume`, async () => {
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-state${k}-src-`));
      const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ic-resume-state${k}-dst-`));
      initFolderStorageRoot(folderRoot);
      const { syncStatePath } = await seedMultiGenLocalVault(localRoot);
      await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: DEK,
        layoutPrefix: PREFIX,
        sourceRoot: localRoot,
        destRoot: folderRoot,
        deviceUuid: DEVICE_A,
        cliStatePath: syncStatePath,
        maxCopyFiles: k,
      });
      assert.ok(loadStorageMigrateState(scopeKey)?.copiedRelativePaths?.length);
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
  }

  it("resumes after a stray migration temp file (multi-gen vault)", async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-resume-kill-src-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-resume-kill-dst-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedMultiGenLocalVault(localRoot);
    await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
      maxCopyFiles: 6,
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
