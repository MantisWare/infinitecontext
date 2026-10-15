import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { objectStorePullSyncChanges, objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { createFolderObjectStore } from "../../lib/storage/folder-object-store.mjs";
import { createLocalObjectStore } from "../../lib/storage/local-object-store.mjs";
import { StorageError, PreconditionFailedError } from "../../lib/storage/errors.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { icloudPlaceholderSiblingPath } from "../../lib/storage/folder-icloud-placeholder.mjs";
import {
  assertFolderObjectFileCopiesClean,
  assertFolderCopyFolderDirsClean,
} from "../../lib/storage/folder-object-conflict-preflight.mjs";
import { deriveDevH, layoutRootPath, logSegmentRelativePath } from "../../lib/storage/layout.mjs";
import { loadStorageManifestForSync } from "../../lib/storage/storage-manifest.mjs";
import { resolveObjectStoreSyncBindingKey } from "../../lib/object-store-sync-binding.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { resetObjectStoreBootstrapForTests } from "../../lib/sync-object-store-bootstrap.mjs";

const DEK = new Uint8Array(32).fill(51);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "accounts/local";

function syncCtx(adapter, deviceUuid, localState) {
  return {
    adapter,
    dek: DEK,
    layoutPrefix: PREFIX,
    selfDevH: deriveDevH(DEK, deviceUuid),
    deviceUuid,
    localState,
  };
}

async function seedTwoDevicesOnFolder(root, localStateA, localStateB) {
  const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
  await adapter.init();
  await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_A, localStateA), [
    { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "a" } } },
  ]);
  await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_B, localStateB), [
    { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "b" } } },
  ]);
  return adapter;
}

describe("PR27 K/M blocking (6a3659e)", () => {
  afterEach(async () => {
    await resetObjectStoreBootstrapForTests();
  });

  describe("K3 placeholder-only evicted segment dir", () => {
    it("preflight, list and push treat placeholder-only log key dir as evicted_placeholder", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k3-ph-only-"));
      const stateFile = path.join(root, "device-a-state.json");
      const localState = createCliFileObjectStoreLocalState(stateFile);
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 40 });
      await adapter.init();
      const writer = syncCtx(adapter, DEVICE_A, localState);
      await objectStorePushSyncMutations(writer, [
        { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "ev" } } },
      ]);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(root, key);
      const genName = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      assert.ok(genName);
      const genPath = path.join(keyDir, genName);
      fs.writeFileSync(icloudPlaceholderSiblingPath(genPath), Buffer.from("stub"));
      fs.unlinkSync(genPath);

      const expectEvicted = (err) => err instanceof StorageError && err.code === "evicted_placeholder";

      await assert.rejects(() => assertFolderObjectFileCopiesClean(adapter, PREFIX), expectEvicted);
      await assert.rejects(() => adapter.list(`${layoutRootPath(PREFIX)}/log/`), expectEvicted);
      await assert.rejects(
        () =>
          objectStorePushSyncMutations(writer, [
            {
              client_id: generateClientNodeId(),
              op: "context_create",
              payload: { metadata: { tag: "after-ev" } },
            },
          ]),
        expectEvicted,
      );

      const stateFileB = path.join(root, "device-b-state.json");
      const localStateB = createCliFileObjectStoreLocalState(stateFileB);
      const reader = syncCtx(adapter, DEVICE_B, localStateB);
      await assert.rejects(
        () => objectStorePullSyncChanges(reader, { since: normalizeVectorSyncCursor(0), limit: 50 }),
        expectEvicted,
      );
    });
  });

  describe("M1' per-binding manifest high-water map", () => {
    it("keeps separate high-waters per binding; legacy scalar migrates without reset", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m1p-map-"));
      const folderRoot = path.join(root, "vault");
      fs.mkdirSync(folderRoot, { recursive: true, mode: 0o700 });
      const localRoot = path.join(root, "local-store");
      fs.mkdirSync(localRoot, { recursive: true, mode: 0o700 });

      const stateFile = path.join(root, "persisted-state.json");
      fs.writeFileSync(
        stateFile,
        `${JSON.stringify({ selfNextSeq: 0, trustedHeads: {}, vectorCursor: { v: {} }, ledger: [], conflicts: [], changeOrdinal: 0, localHlc: { wall_ms: 0, counter: 0 }, logListCursor: "", manifestGenerationHighWater: 12 }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const localState = createCliFileObjectStoreLocalState(stateFile);

      const localConfig = {
        storage: { backend: "local-filesystem", rootDir: localRoot, deviceUuid: DEVICE_A },
      };
      const localBinding = resolveObjectStoreSyncBindingKey(localConfig);
      const localStore = await createLocalObjectStore({
        dek: DEK,
        deviceUuid: DEVICE_A,
        config: localConfig,
        sync: { mode: "cli", persist: false },
        rootDir: localRoot,
        localState,
        layoutPrefix: PREFIX,
      });
      await localStore.close();

      let loaded = localState.load();
      assert.equal(loaded.manifestGenerationHighWater, 12);
      assert.equal(loaded.manifestGenerationHighWaterByBindingKey?.[localBinding], 12);

      const folderConfig = {
        storage: { backend: "folder", folder: { path: folderRoot }, deviceUuid: DEVICE_A },
      };
      const folderBinding = resolveObjectStoreSyncBindingKey(folderConfig);
      assert.notEqual(localBinding, folderBinding);

      await seedTwoDevicesOnFolder(
        folderRoot,
        createCliFileObjectStoreLocalState(path.join(root, "fa.json")),
        createCliFileObjectStoreLocalState(path.join(root, "fb.json")),
      );

      const folderState = createCliFileObjectStoreLocalState(stateFile);
      const folderStore = await createFolderObjectStore({
        dek: DEK,
        deviceUuid: DEVICE_A,
        config: folderConfig,
        sync: { mode: "cli", persist: true },
        rootDir: folderRoot,
        localState: folderState,
        layoutPrefix: PREFIX,
      });
      loaded = folderState.load();
      assert.equal(loaded.manifestGenerationHighWaterByBindingKey?.[localBinding], 12);
      assert.equal(loaded.manifestGenerationHighWaterByBindingKey?.[folderBinding] ?? 0, 0);
      assert.equal(loaded.manifestGenerationHighWater, 0);
      await folderStore.close();

      loaded = folderState.load();
      loaded.manifestGenerationHighWaterByBindingKey[folderBinding] = 7;
      await folderState.save(loaded);
      loaded = folderState.load();
      assert.equal(loaded.manifestGenerationHighWaterByBindingKey[folderBinding], 7);
      assert.equal(loaded.manifestGenerationHighWaterByBindingKey[localBinding], 12);
    });

    it("symlink folder path shares binding key and high-water with realpath target", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m1p-symlink-"));
      const target = path.join(root, "target");
      const link = path.join(root, "link");
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.symlinkSync(target, link, "dir");

      const cfgTarget = { storage: { backend: "folder", folder: { path: target }, deviceUuid: DEVICE_A } };
      const cfgLink = { storage: { backend: "folder", folder: { path: link }, deviceUuid: DEVICE_A } };
      const binding = resolveObjectStoreSyncBindingKey(cfgTarget);
      assert.equal(binding, resolveObjectStoreSyncBindingKey(cfgLink));

      const stateFile = path.join(root, "state.json");
      const state = createCliFileObjectStoreLocalState(stateFile);
      await seedTwoDevicesOnFolder(
        target,
        createCliFileObjectStoreLocalState(path.join(root, "a.json")),
        createCliFileObjectStoreLocalState(path.join(root, "b.json")),
      );

      const storeViaTarget = await createFolderObjectStore({
        dek: DEK,
        deviceUuid: DEVICE_A,
        config: cfgTarget,
        sync: { mode: "cli", persist: true },
        rootDir: target,
        localState: state,
        layoutPrefix: PREFIX,
      });
      const after = state.load();
      after.manifestGenerationHighWaterByBindingKey = after.manifestGenerationHighWaterByBindingKey ?? {};
      after.manifestGenerationHighWaterByBindingKey[binding] = 9;
      after.storageBindingKey = binding;
      after.manifestGenerationHighWater = 9;
      await state.save(after);
      await storeViaTarget.close();

      const reloaded = createCliFileObjectStoreLocalState(stateFile).load();
      assert.equal(reloaded.manifestGenerationHighWaterByBindingKey[binding], 9);
      assert.equal(resolveObjectStoreSyncBindingKey(cfgLink), binding);
    });

    it("two devices open folder backend concurrently with persisted state files", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m1p-concurrent-"));
      const folderRoot = path.join(root, "folder");
      fs.mkdirSync(folderRoot, { recursive: true, mode: 0o700 });
      await seedTwoDevicesOnFolder(
        folderRoot,
        createCliFileObjectStoreLocalState(path.join(root, "seed-a.json")),
        createCliFileObjectStoreLocalState(path.join(root, "seed-b.json")),
      );

      const config = { storage: { backend: "folder", folder: { path: folderRoot }, deviceUuid: DEVICE_A } };
      const stateA = path.join(root, "dev-a.json");
      const stateB = path.join(root, "dev-b.json");

      const [openA, openB] = await Promise.all([
        createFolderObjectStore({
          dek: DEK,
          deviceUuid: DEVICE_A,
          config: { ...config, storage: { ...config.storage, deviceUuid: DEVICE_A } },
          sync: { mode: "cli", persist: true },
          rootDir: folderRoot,
          localState: createCliFileObjectStoreLocalState(stateA),
          layoutPrefix: PREFIX,
        }),
        createFolderObjectStore({
          dek: DEK,
          deviceUuid: DEVICE_B,
          config: { ...config, storage: { ...config.storage, deviceUuid: DEVICE_B } },
          sync: { mode: "cli", persist: true },
          rootDir: folderRoot,
          localState: createCliFileObjectStoreLocalState(stateB),
          layoutPrefix: PREFIX,
        }),
      ]);

      const pullB = await objectStorePullSyncChanges(
        syncCtx(openB.adapter, DEVICE_B, openB.localState),
        { since: normalizeVectorSyncCursor(0), limit: 50 },
      );
      assert.ok(pullB.changes.length >= 1);
      await openA.close();
      await openB.close();
    });

    it("rejects provider manifest rollback below binding high-water on same root", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m1p-rollback-"));
      const stateFile = path.join(root, "state.json");
      const localState = createCliFileObjectStoreLocalState(stateFile);
      const adapter = await seedTwoDevicesOnFolder(
        root,
        createCliFileObjectStoreLocalState(path.join(root, "sa.json")),
        localState,
      );
      const state = localState.load();
      const binding = resolveObjectStoreSyncBindingKey({
        storage: { backend: "folder", folder: { path: root }, deviceUuid: DEVICE_A },
      });
      state.storageBindingKey = binding;
      state.manifestGenerationHighWaterByBindingKey = { [binding]: 50 };
      state.manifestGenerationHighWater = 50;
      await localState.save(state);

      await assert.rejects(
        () => loadStorageManifestForSync(adapter, DEK, PREFIX, localState.load()),
        (err) => err instanceof PreconditionFailedError,
      );
    });
  });
});
