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
import { MIGRATION_DEST_SYMLINK_OR_ESCAPE_MESSAGE } from "../../lib/storage/storage-migrate-dest-path-guard.mjs";
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

function listSourceObjectRelPaths(sourceRoot) {
  const srcObjects = path.join(sourceRoot, "objects");
  /** @type {string[]} */
  const out = [];
  const walk = (cursor, rel) => {
    for (const ent of fs.readdirSync(cursor, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(cursor, ent.name);
      if (ent.isDirectory()) {
        walk(full, childRel);
      } else if (ent.isFile()) {
        out.push(`objects/${childRel}`.replace(/\\/g, "/"));
      }
    }
  };
  walk(srcObjects, "");
  return out.sort();
}

function countRegularFilesUnder(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (cursor) => {
    for (const ent of fs.readdirSync(cursor, { withFileTypes: true })) {
      const full = path.join(cursor, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) n += 1;
    }
  };
  walk(dir);
  return n;
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

  it("same-key swap: one foreign object at an existing relative path aborts before extra writes", async () => {
    const scopeKey = "migrate-swap-same-key";
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-swap-sk-src-"));
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-swap-sk-fr-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-swap-sk-d-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedLocalVault(localRoot, DEVICE_A);
    await seedLocalVault(foreignRoot, DEVICE_B);
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }

    const partial = await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
      maxCopyFiles: 4,
    });
    assert.equal(partial.phase, "copying");
    const state = loadStorageMigrateState(scopeKey);
    const copied = state?.copiedRelativePaths ?? [];
    assert.ok(copied.length >= 2);
    const swapRel = copied[1];
    const copiedBefore = copied.length;
    const foreignPaths = listSourceObjectRelPaths(foreignRoot);
    assert.ok(foreignPaths.length, "foreign vault should have objects");
    const donorRel = foreignPaths[0];
    const swapDestPath = path.join(folderRoot, swapRel);
    fs.mkdirSync(path.dirname(swapDestPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(foreignRoot, donorRel), swapDestPath);

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
        }),
      (err) =>
        err instanceof StorageError &&
        (/identity changed|Destination vault identity|refuses to overwrite/i.test(String(err.message))),
    );

    const after = loadStorageMigrateState(scopeKey);
    assert.equal(after?.copiedRelativePaths?.length ?? 0, copiedBefore);
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }
  });
});

describe("storage migrate destination symlink attacks", () => {
  it("refuses a device directory replaced by a symlink to outside the destination", async () => {
    const scopeKey = "migrate-symlink-dir";
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-dir-src-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-dir-d-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-out-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedLocalVault(localRoot, DEVICE_A);
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }

    const outsideBefore = countRegularFilesUnder(outsideRoot);

    const partial = await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
      maxCopyFiles: 4,
    });
    assert.equal(partial.phase, "copying");
    const migrateState = loadStorageMigrateState(scopeKey);
    const copiedSet = new Set(migrateState?.copiedRelativePaths ?? []);
    const allRel = listSourceObjectRelPaths(localRoot);
    const nextRel = allRel.find((rel) => !copiedSet.has(rel));
    assert.ok(nextRel, "expected a pending source object for symlink dir attack");
    const attackDir = path.join(folderRoot, path.dirname(nextRel));
    fs.mkdirSync(path.dirname(attackDir), { recursive: true, mode: 0o700 });
    if (fs.existsSync(attackDir)) {
      fs.rmSync(attackDir, { recursive: true, force: true });
    }
    fs.symlinkSync(outsideRoot, attackDir, "dir");

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
        }),
      (err) =>
        err instanceof StorageError &&
        String(err.message).includes(MIGRATION_DEST_SYMLINK_OR_ESCAPE_MESSAGE),
    );

    assert.equal(countRegularFilesUnder(outsideRoot), outsideBefore);
    const after = loadStorageMigrateState(scopeKey);
    assert.notEqual(after?.verified, true);
    assert.notEqual(after?.phase, "verified");
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }
  });

  it("refuses a copied destination file replaced by a symlink to the source (fingerprint bypass)", async () => {
    const scopeKey = "migrate-symlink-file";
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-file-src-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-file-d-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedLocalVault(localRoot, DEVICE_A);
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }

    const partial = await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
      maxCopyFiles: 6,
    });
    assert.equal(partial.phase, "copying");
    const state = loadStorageMigrateState(scopeKey);
    const copied = state?.copiedRelativePaths ?? [];
    assert.ok(copied.length >= 2);
    const victimRel = copied[0];
    const destFile = path.join(folderRoot, victimRel);
    const srcFile = path.join(localRoot, victimRel);
    fs.unlinkSync(destFile);
    fs.symlinkSync(srcFile, destFile);

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
        }),
      (err) =>
        err instanceof StorageError &&
        String(err.message).includes(MIGRATION_DEST_SYMLINK_OR_ESCAPE_MESSAGE),
    );

    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }
  });

  it("refuses a symlinked file at an uncopied path before verify", async () => {
    const scopeKey = "migrate-symlink-uncopied";
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-unc-src-"));
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mig-slink-unc-d-"));
    initFolderStorageRoot(folderRoot);
    const { syncStatePath } = await seedLocalVault(localRoot, DEVICE_A);
    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }

    const allRel = listSourceObjectRelPaths(localRoot);
    const partial = await runStorageMigrateLocalToFolder({
      scopeKey,
      dek: DEK,
      layoutPrefix: PREFIX,
      sourceRoot: localRoot,
      destRoot: folderRoot,
      deviceUuid: DEVICE_A,
      cliStatePath: syncStatePath,
      maxCopyFiles: 3,
    });
    assert.equal(partial.phase, "copying");
    const state = loadStorageMigrateState(scopeKey);
    const copied = new Set(state?.copiedRelativePaths ?? []);
    const uncopiedRel = allRel.find((rel) => !copied.has(rel));
    assert.ok(uncopiedRel, "expected an uncopied relative path");
    const trapPath = path.join(folderRoot, uncopiedRel);
    fs.mkdirSync(path.dirname(trapPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(localRoot, uncopiedRel), trapPath);

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
        }),
      (err) =>
        err instanceof StorageError &&
        String(err.message).includes(MIGRATION_DEST_SYMLINK_OR_ESCAPE_MESSAGE),
    );

    try {
      fs.unlinkSync(storageMigrateStatePath(scopeKey));
    } catch {
      /* ignore */
    }
  });
});
