import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { objectStorePullSyncChanges, objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { quarantineObjectsRelativePath } from "../../lib/storage/folder-quarantine.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { icloudPlaceholderSiblingPath } from "../../lib/storage/folder-icloud-placeholder.mjs";
import { deriveDevH, deviceEncRelativePath, layoutRootPath, logSegmentRelativePath } from "../../lib/storage/layout.mjs";
import { loadFolderMergedManifest } from "../../lib/storage/storage-manifest-folder.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";

const DEK = new Uint8Array(32).fill(44);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "accounts/local";

function syncCtx(adapter, deviceUuid, localState = createInMemoryObjectStoreLocalState()) {
  return {
    adapter,
    dek: DEK,
    layoutPrefix: PREFIX,
    selfDevH: deriveDevH(DEK, deviceUuid),
    deviceUuid,
    localState,
  };
}

async function seedTwoDevices(root) {
  const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
  await adapter.init();
  await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_A), [
    { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "a" } } },
  ]);
  await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_B), [
    { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "b" } } },
  ]);
  return adapter;
}

describe("PR27 D/K/M blocking (994a533)", () => {
  describe("D1 devices/ file-level .icgen conflicts", () => {
    it("get and merge raise corrupt_storage for foreign devices/ copy (never null / silent drop)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-d1-dev-"));
      await seedTwoDevices(root);
      const keyB = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_B));
      const { keyDir } = objectKeyDirectory(root, keyB);
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      fs.writeFileSync(
        path.join(keyDir, gen.replace(".icgen", " 2.icgen")),
        sampleEncryptedObjectBytesForKey(`${keyB}-foreign`),
      );
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
      const expectConflict = (err) =>
        err instanceof StorageError && (err.code === "corrupt_storage" || err.code === "storage_fork");
      await assert.rejects(() => adapter.init(), expectConflict);
      await assert.rejects(() => adapter.get(keyB), expectConflict);
      await assert.rejects(() => loadFolderMergedManifest(adapter, DEK, PREFIX), expectConflict);
    });
  });

  describe("K3 evicted log segment on push", () => {
    it("push raises evicted_placeholder (not log_missing) when log segment is evicted", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k3-push-ev-"));
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 40 });
      await adapter.init();
      const writer = syncCtx(adapter, DEVICE_A);
      await objectStorePushSyncMutations(writer, [
        { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "ev" } } },
      ]);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(root, key);
      const genPath = path.join(keyDir, fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen")));
      fs.writeFileSync(icloudPlaceholderSiblingPath(genPath), Buffer.from("stub"));
      await assert.rejects(
        () =>
          objectStorePushSyncMutations(writer, [
            {
              client_id: generateClientNodeId(),
              op: "context_create",
              payload: { metadata: { tag: "after-ev" } },
            },
          ]),
        (err) => err instanceof StorageError && err.code === "evicted_placeholder",
      );
    });

    it("list throws evicted_placeholder for evicted log segment", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k3-list-ev-"));
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 40 });
      await adapter.init();
      await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_A), [
        { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { tag: "ev-list" } } },
      ]);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(root, key);
      const genPath = path.join(keyDir, fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen")));
      fs.writeFileSync(icloudPlaceholderSiblingPath(genPath), Buffer.from("stub"));
      await assert.rejects(
        () => adapter.list(`${layoutRootPath(PREFIX)}/log/`),
        (err) => err instanceof StorageError && err.code === "evicted_placeholder",
      );
    });
  });

  describe("minor quarantine dedupe", () => {
    it("skips a new quarantine copy when an identical tree already exists under quarantine", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-q-dedupe-"));
      const rel = "accounts/local/ic-v1/log/x/000000000000.enc";
      const src = path.join(root, "objects", rel);
      fs.mkdirSync(src, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(src, "000000000001.icgen"), Buffer.from("same-payload"));
      const quarantineRoot = path.join(root, "quarantine", "repair");
      fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      const existing = path.join(quarantineRoot, "prior", rel);
      fs.mkdirSync(existing, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(existing, "000000000001.icgen"), Buffer.from("same-payload"));
      assert.equal(quarantineObjectsRelativePath(root, rel, quarantineRoot), true);
      assert.equal(fs.existsSync(src), false);
      assert.equal(fs.readdirSync(quarantineRoot).filter((n) => n !== "prior").length, 0);
    });
  });
});
