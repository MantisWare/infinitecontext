import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { objectStorePullSyncChanges, objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { icloudPlaceholderSiblingPath } from "../../lib/storage/folder-icloud-placeholder.mjs";
import { deriveDevH, deviceEncRelativePath, layoutRootPath, snapEncRelativePath } from "../../lib/storage/layout.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { compactObjectStoreReplica, listSnapshotEpochs } from "../../lib/storage/storage-compaction.mjs";
import { pickVerifiedCompactionFloor } from "../../lib/storage/compaction-floor-tuple.mjs";
import { assertLocalObjectStoreRootNotSynced } from "../../lib/storage/sync-root-guard.mjs";
import { createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { sealLayoutObjectPlaintext } from "../../lib/storage/storage-cas-rmw.mjs";
import { wrapDeviceManifestContribution } from "../../lib/storage/storage-manifest-folder.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";

const DEK = new Uint8Array(32).fill(9);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "accounts/pr27";

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

function mulberry32(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("PR27 blocking regressions", () => {
  it("F4: local backend refuses known synced roots", () => {
    assert.throws(
      () =>
        assertLocalObjectStoreRootNotSynced(
          path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "vault"),
        ),
      (err) => err instanceof StorageError && err.code === "invalid_argument",
    );
  });

  it("F3: evicted iCloud placeholders raise evicted_placeholder on get and list", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pr27-ph-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 50 });
    await adapter.init();
    const key = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A));
    const keyDir = path.join(root, "objects", ...key.split("/"));
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(keyDir, "000000000001.icgen"), Buffer.from("x"));
    fs.writeFileSync(icloudPlaceholderSiblingPath(path.join(keyDir, "000000000001.icgen")), Buffer.from(""));

    await assert.rejects(
      () => adapter.get(key),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
    await assert.rejects(
      () => adapter.list(`${layoutRootPath(PREFIX)}/devices/`, { limit: 20 }),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
  });

  it("F2: compaction floor uses atomic tuple (seeds 3, 5, 6)", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const ctx = { adapter, dek: DEK, layoutPrefix: PREFIX };
    for (const seed of [3, 5, 6]) {
      const rand = mulberry32(seed);
      const claims = [
        {
          epoch: 5,
          compacted_through: normalizeVectorSyncCursor({ v: { AAA: 3 } }),
          snapshot_digest: crypto.randomBytes(32).toString("hex"),
        },
        {
          epoch: 4,
          compacted_through: normalizeVectorSyncCursor({ v: { AAA: 2 } }),
          snapshot_digest: crypto.randomBytes(32).toString("hex"),
        },
      ];
      if (rand() > 0.5) claims.reverse();
      const floor = await pickVerifiedCompactionFloor(ctx, claims);
      assert.equal(floor.epoch, -1);
      assert.deepEqual(floor.compacted_through, normalizeVectorSyncCursor(0));
    }
  });

  it("F1: concurrent compaction on CAS backend and folder vault replays with snapshot conflict copies", async () => {
    const shared = createMemoryStorageAdapter();
    await shared.init();
    const writerA = syncCtx(shared, DEVICE_A);
    const writerB = syncCtx(shared, DEVICE_B);
    await objectStorePushSyncMutations(writerA, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "compact-a" } },
      },
    ]);
    const replica = createEmptySyncReplica();
    await Promise.allSettled([
      compactObjectStoreReplica(writerA, writerA.localState.load(), replica, { settleMs: 0 }),
      compactObjectStoreReplica(writerB, writerB.localState.load(), replica, { settleMs: 0 }),
    ]);
    assert.ok((await listSnapshotEpochs(writerA)).length >= 1);

    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pr27-folder-"));
    const folder = createFolderStorageAdapter({ rootDir: folderRoot, placeholderTimeoutMs: 100 });
    await folder.init();
    const folderWriter = syncCtx(folder, DEVICE_A);
    await objectStorePushSyncMutations(folderWriter, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "folder-replay" } },
      },
    ]);
    const snapKey = snapEncRelativePath(PREFIX, 0);
    const { keyDir } = objectKeyDirectory(folderRoot, snapKey);
    if (fs.existsSync(keyDir)) {
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen") && !n.includes(" "));
      if (gen) {
        const altDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
        fs.mkdirSync(altDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(keyDir, gen), path.join(altDir, gen.replace(".icgen", " 2.icgen")));
      }
    }

    const skipped = await compactObjectStoreReplica(
      folderWriter,
      folderWriter.localState.load(),
      createEmptySyncReplica(),
      { settleMs: 0 },
    );
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "compaction_disabled");

    const reader = syncCtx(folder, DEVICE_B);
    const pull = await objectStorePullSyncChanges(reader, { since: normalizeVectorSyncCursor(0), limit: 200 });
    assert.ok(pull.changes.some((c) => c.payload?.metadata?.tag === "folder-replay"));
  });

  it("lock file conflict copies at same generation raise storage_fork", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pr27-lock-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 100 });
    await adapter.init();
    const lockKey = `${PREFIX}/lock/test.lock`;
    const bodyA = sampleEncryptedObjectBytesForKey(lockKey);
    const bodyB = sampleEncryptedObjectBytesForKey(`${lockKey}-alt`);
    await adapter.put(lockKey, bodyA, { ifNoneMatch: "*" });
    const { keyDir } = objectKeyDirectory(root, lockKey);
    const genName = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen") && !n.includes(" "));
    assert.ok(genName);
    const altDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
    fs.mkdirSync(altDir, { recursive: true, mode: 0o700 });
    const altName = genName.replace(".icgen", " 2.icgen");
    const { buildLiveObjectHeader } = await import("../../lib/storage/filesystem-generations.mjs");
    const { encodeObjectFile } = await import("../../lib/storage/filesystem-object-file.mjs");
    const built = buildLiveObjectHeader(lockKey, bodyB, 1);
    fs.writeFileSync(path.join(altDir, altName), encodeObjectFile(built.header, built.body));

    await assert.rejects(
      () => adapter.get(lockKey),
      (err) => err instanceof StorageError && err.code === "storage_fork",
    );
  });

  it("undecryptable device contribution fails closed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pr27-bad-dev-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 100 });
    await adapter.init();
    const key = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A));
    const good = sealLayoutObjectPlaintext(
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
      }),
    );
    await adapter.put(key, good, { ifNoneMatch: "*" });
    const wrongDek = new Uint8Array(32).fill(2);
    const { loadFolderMergedManifest } = await import("../../lib/storage/storage-manifest-folder.mjs");
    await assert.rejects(() => loadFolderMergedManifest(adapter, wrongDek, PREFIX), /Undecryptable device manifest/);
  });
});
