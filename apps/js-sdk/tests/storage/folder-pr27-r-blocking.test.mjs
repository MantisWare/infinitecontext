import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { objectStorePullSyncChanges, objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { writeConfigFile } from "../../lib/client-config.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { repairFolderObjectStoreVault } from "../../lib/storage/folder-storage-repair.mjs";
import { assertFolderVaultLogsBeginAtSeqZero } from "../../lib/storage/folder-vault-preflight.mjs";
import { createFolderObjectStore } from "../../lib/storage/folder-object-store.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { buildLiveObjectHeader, objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { encodeObjectFile } from "../../lib/storage/filesystem-object-file.mjs";
import { icloudPlaceholderSiblingPath } from "../../lib/storage/folder-icloud-placeholder.mjs";
import {
  deriveDevH,
  deviceEncRelativePath,
  layoutRootPath,
  logSegmentRelativePath,
  snapEncRelativePath,
} from "../../lib/storage/layout.mjs";
import { sealLayoutObjectPlaintext } from "../../lib/storage/storage-cas-rmw.mjs";
import {
  loadFolderMergedManifest,
  wrapDeviceManifestContribution,
} from "../../lib/storage/storage-manifest-folder.mjs";
import { wrapDeviceSyncAckPlain } from "../../lib/storage/storage-device-sync-ack.mjs";
import { assertLocalObjectStoreRootNotSynced } from "../../lib/storage/sync-root-guard.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { resetObjectStoreBootstrapForTests } from "../../lib/sync-object-store-bootstrap.mjs";

const DEK = new Uint8Array(32).fill(21);
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

async function seedThreeSegmentLog(writer) {
  for (let i = 0; i < 3; i += 1) {
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: `seg-${i}` } },
      },
    ]);
  }
}

describe("PR27 R-blocking (7792d1b)", () => {
  afterEach(async () => {
    await resetObjectStoreBootstrapForTests();
    delete process.env.INFINITECONTEXT_TEST_UNLOCKED_DEK_B64;
  });

  it("R1: repair runs without scanCanonicalKeysFromObjectsTree ReferenceError", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-r1-repair-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "repair-me" } },
      },
    ]);
    const snapKey = snapEncRelativePath(PREFIX, 0);
    const { keyDir } = objectKeyDirectory(root, snapKey);
    if (fs.existsSync(keyDir)) {
      const altDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
      fs.mkdirSync(altDir, { recursive: true, mode: 0o700 });
      fs.cpSync(keyDir, altDir, { recursive: true });
    }
    const result = await repairFolderObjectStoreVault(writer, { dryRun: true });
    assert.ok(Array.isArray(result.moved));
  });

  it("R1/R2: doctor --repair via CLI with unlocked vault quarantines snap conflict copy", async () => {
    const home = process.env.HOME;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-r-cli-repair-"));
    writeConfigFile({
      baseUrl: "http://127.0.0.1:9",
      storage: { backend: "folder", folder: { path: root }, deviceUuid: DEVICE_A },
    });
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "cli-repair" } },
      },
    ]);
    const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
    const { keyDir } = objectKeyDirectory(root, key);
    const conflictDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
    fs.mkdirSync(conflictDir, { recursive: true, mode: 0o700 });
    fs.cpSync(keyDir, conflictDir, { recursive: true });
    process.env.INFINITECONTEXT_TEST_UNLOCKED_DEK_B64 = Buffer.from(DEK).toString("base64");
    const { runStorageCli } = await import("../../src/cli/storage-cli.mjs");
    await runStorageCli("doctor", ["--repair"]);
    assert.equal(fs.existsSync(conflictDir), false);
    assert.ok(fs.existsSync(path.join(root, "quarantine", "repair")));
    assert.equal(process.env.HOME, home);
  });

  it("R2: repair refuses when log segment copy folders diverge (storage_fork)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-r2-fork-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await seedThreeSegmentLog(writer);
    const segKey = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 1);
    const { keyDir } = objectKeyDirectory(root, segKey);
    const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
    assert.ok(gen);
    const altDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
    fs.mkdirSync(altDir, { recursive: true, mode: 0o700 });
    const altGen = gen.replace(".icgen", " 2.icgen");
    fs.copyFileSync(path.join(keyDir, gen), path.join(altDir, altGen));
    const buf = fs.readFileSync(path.join(altDir, altGen));
    buf[buf.length - 3] ^= 0xff;
    fs.writeFileSync(path.join(altDir, altGen), buf);
    await assert.rejects(
      () => repairFolderObjectStoreVault(writer),
      (err) =>
        err instanceof StorageError &&
        (err.code === "storage_fork" || err.code === "corrupt_storage"),
    );
    assert.ok(fs.existsSync(altDir));
  });

  it("M1: only owner rewrites legacy v1 devices/ file on disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-m1-migrate-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const keyB = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_B));
    const legacyB = sealLayoutObjectPlaintext(
      DEK,
      keyB,
      wrapDeviceSyncAckPlain({
        dev: DEVICE_B,
        acknowledged_seq: 0,
        acknowledged_cursor: normalizeVectorSyncCursor(0),
        updated_at: new Date().toISOString(),
      }),
    );
    await adapter.put(keyB, legacyB, { ifNoneMatch: "*" });
    const bodyBefore = await adapter.get(keyB);
    assert.ok(bodyBefore?.body);
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "owner-migrate" } },
      },
    ]);
    const bodyAfterA = await adapter.get(keyB);
    assert.equal(
      Buffer.from(bodyAfterA.body).compare(Buffer.from(bodyBefore.body)),
      0,
      "device B sidecar must stay legacy on disk when A pushes",
    );
    const merged = await loadFolderMergedManifest(adapter, DEK, PREFIX);
    assert.equal(merged.devices.length, 2);
    await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_B), [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "b-push" } },
      },
    ]);
    const bodyAfterB = await adapter.get(keyB);
    assert.notEqual(
      Buffer.from(bodyAfterB.body).compare(Buffer.from(bodyBefore.body)),
      0,
      "device B must migrate its own sidecar on push",
    );
  });

  it("H1: new device rejects truncated tail (3 segments, head claims seq 2 but seq 2 missing)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-h1-trunc-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await seedThreeSegmentLog(writer);
    const devH = deriveDevH(DEK, DEVICE_A);
    const seg2 = logSegmentRelativePath(PREFIX, devH, 2);
    const { keyDir } = objectKeyDirectory(root, seg2);
    fs.rmSync(keyDir, { recursive: true, force: true });
    const reader = syncCtx(adapter, DEVICE_B);
    await assert.rejects(
      () => objectStorePullSyncChanges(reader, { since: normalizeVectorSyncCursor(0), limit: 50 }),
      (err) => err?.code === "log_rollback" || err?.code === "log_missing",
    );
  });

  it("K3: evicted devices/ sidecar throws evicted_placeholder without dropping participants silently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k3-dev-ph-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 40 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "dev-ph" } },
      },
    ]);
    await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_B), [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "dev-b" } },
      },
    ]);
    const keyB = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_B));
    const { keyDir } = objectKeyDirectory(root, keyB);
    const genPath = path.join(keyDir, fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen")));
    fs.writeFileSync(icloudPlaceholderSiblingPath(genPath), Buffer.from("stub"));
    await assert.rejects(
      () => loadFolderMergedManifest(adapter, DEK, PREFIX),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
  });

  it("K3: list throws evicted_placeholder; push does not report log_missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k3-list-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 40 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "ph" } },
      },
    ]);
    const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
    const { keyDir } = objectKeyDirectory(root, key);
    const genPath = path.join(keyDir, fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen")));
    fs.writeFileSync(icloudPlaceholderSiblingPath(genPath), Buffer.from("stub"));
    await assert.rejects(
      () => adapter.list(`${layoutRootPath(PREFIX)}/log/`),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
    await assert.rejects(
      () =>
        objectStorePushSyncMutations(writer, [
          {
            client_id: generateClientNodeId(),
            op: "context_create",
            payload: { metadata: { tag: "after-ph" } },
          },
        ]),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
  });

  it("O1: owner open max-merges own devices/ fork and quarantines conflict copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-o1-owner-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await seedThreeSegmentLog(writer);
    const key = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A));
    const { keyDir } = objectKeyDirectory(root, key);
    const conflictDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
    fs.mkdirSync(conflictDir, { recursive: true, mode: 0o700 });
    fs.cpSync(keyDir, conflictDir, { recursive: true });
    const stale = sealLayoutObjectPlaintext(
      DEK,
      key,
      wrapDeviceManifestContribution({
        devH: deriveDevH(DEK, DEVICE_A),
        record_generation: 1,
        sync_participant: true,
        last_seq: 0,
        acknowledged_seq: 0,
        latest_snapshot_epoch: -1,
        compacted_through: normalizeVectorSyncCursor(0),
        removed_devices: [],
        trusted_head: { seq: 0, digest: writer.localState.load().trustedHeads[deriveDevH(DEK, DEVICE_A)].digest },
      }),
    );
    const conflictGen = fs.readdirSync(conflictDir).find((n) => n.endsWith(".icgen"));
    fs.writeFileSync(path.join(conflictDir, conflictGen), stale);
    await objectStorePullSyncChanges(writer, { since: normalizeVectorSyncCursor(0), limit: 50 });
    assert.equal(fs.existsSync(conflictDir), false);
    const merged = await loadFolderMergedManifest(adapter, DEK, PREFIX);
    assert.ok((merged.trusted_heads?.[deriveDevH(DEK, DEVICE_A)]?.seq ?? -1) >= 2);
  });

  it("C1: foreign undecryptable log conflict copy raises corrupt_storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-c1-foreign-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "c1" } },
      },
    ]);
    const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
    const { keyDir } = objectKeyDirectory(root, key);
    const altDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
    fs.mkdirSync(altDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(altDir, "000000000001.icgen"), sampleEncryptedObjectBytesForKey(key + "-foreign"));
    await assert.rejects(
      () => objectStorePullSyncChanges(syncCtx(adapter, DEVICE_B), { since: normalizeVectorSyncCursor(0), limit: 50 }),
      (err) => err instanceof StorageError && err.code === "corrupt_storage",
    );
  });

  it("extra: folder open refuses vault missing seq 0 after GC-style truncation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-seq0-refuse-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const devH = deriveDevH(DEK, DEVICE_A);
    const key1 = logSegmentRelativePath(PREFIX, devH, 1);
    const { keyDir } = objectKeyDirectory(root, key1);
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const body = sampleEncryptedObjectBytesForKey(key1);
    const gen = "000000000001.icgen";
    fs.writeFileSync(
      path.join(keyDir, gen),
      encodeObjectFile(buildLiveObjectHeader(key1, body, 1).header, body),
    );
    await assert.rejects(
      () =>
        createFolderObjectStore({
          dek: DEK,
          deviceUuid: DEVICE_A,
          rootDir: root,
          config: { storage: { backend: "folder", folder: { path: root }, deviceUuid: DEVICE_A } },
          sync: { mode: "cli", persist: false },
          layoutPrefix: PREFIX,
        }),
      (err) => err instanceof StorageError && /seq 0/i.test(err.message),
    );
    await assert.rejects(
      () => assertFolderVaultLogsBeginAtSeqZero(adapter, DEK, PREFIX),
      (err) => err instanceof StorageError && err.code === "invalid_argument",
    );
  });

  it("extra: sync-root guard detects /mnt/Dropbox/.dropbox ancestor", () => {
    const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-dropbox-mount-"));
    fs.mkdirSync(path.join(mountRoot, ".dropbox"), { recursive: true });
    const vaultPath = path.join(mountRoot, "team", "vault");
    fs.mkdirSync(vaultPath, { recursive: true });
    assert.throws(() => assertLocalObjectStoreRootNotSynced(vaultPath), (err) => err instanceof StorageError);
  });
});
