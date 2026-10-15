import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { objectStorePullSyncChanges, objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { icloudPlaceholderSiblingPath } from "../../lib/storage/folder-icloud-placeholder.mjs";
import { buildLiveObjectHeader, objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { encodeObjectFile } from "../../lib/storage/filesystem-object-file.mjs";
import { deriveDevH, deviceEncRelativePath, layoutRootPath, snapEncRelativePath } from "../../lib/storage/layout.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import {
  assertLocalObjectStoreRootNotSynced,
  isKnownSyncedFolderRoot,
} from "../../lib/storage/sync-root-guard.mjs";
import { sealLayoutObjectPlaintext } from "../../lib/storage/storage-cas-rmw.mjs";
import { wrapDeviceSyncAckPlain } from "../../lib/storage/storage-device-sync-ack.mjs";
import { loadFolderMergedManifest } from "../../lib/storage/storage-manifest-folder.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";

const DEK = new Uint8Array(32).fill(11);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "accounts/kblock";

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

describe("PR27 K-blocking regressions", () => {
  it("K1: init succeeds with identical iCloud and Dropbox conflict copies present before init", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k1-init-"));
    const key = `${PREFIX}/ic-v1/log/${deriveDevH(DEK, DEVICE_A).toLowerCase()}/000000000000.enc`;
    const { keyDir } = objectKeyDirectory(root, key);
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const body = sampleEncryptedObjectBytesForKey(key);
    const gen = "000000000001.icgen";
    const payload = encodeObjectFile(buildLiveObjectHeader(key, body, 1).header, body);
    fs.writeFileSync(path.join(keyDir, gen), payload);
    fs.copyFileSync(path.join(keyDir, gen), path.join(keyDir, "000000000001 2.icgen"));
    fs.copyFileSync(
      path.join(keyDir, gen),
      path.join(keyDir, "000000000001 (conflicted copy).icgen"),
    );
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await assert.doesNotReject(() => adapter.init());
    const got = await adapter.get(key);
    assert.ok(got);
  });

  it("K2: folder init and pull ignore forked snap/00000000.enc copies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k2-snap-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    const writer = syncCtx(adapter, DEVICE_A);
    await objectStorePushSyncMutations(writer, [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { tag: "post-snap-fork" } },
      },
    ]);
    const snapKey = snapEncRelativePath(PREFIX, 0);
    const { keyDir } = objectKeyDirectory(root, snapKey);
    if (fs.existsSync(keyDir)) {
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      if (gen) {
        const altDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
        fs.mkdirSync(altDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(keyDir, gen), path.join(altDir, gen.replace(".icgen", " 2.icgen")));
        const alt = path.join(altDir, gen.replace(".icgen", " 2.icgen"));
        const buf = fs.readFileSync(alt);
        buf[Math.max(0, buf.length - 10)] ^= 0x7;
        fs.writeFileSync(alt, buf);
      }
    }
    const reader = syncCtx(adapter, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const pull = await objectStorePullSyncChanges(reader, { since: normalizeVectorSyncCursor(0), limit: 50 });
    assert.ok(pull.changes.some((c) => c.payload?.metadata?.tag === "post-snap-fork"));
  });

  it("K3: file-level .icgen.icloud placeholder throws evicted_placeholder on get", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k3-file-ph-"));
    const key = `${PREFIX}/ic-v1/log/${deriveDevH(DEK, DEVICE_A).toLowerCase()}/000000000001.enc`;
    const { keyDir } = objectKeyDirectory(root, key);
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const genPath = path.join(keyDir, "000000000001.icgen");
    fs.writeFileSync(genPath, sampleEncryptedObjectBytesForKey(key));
    fs.writeFileSync(icloudPlaceholderSiblingPath(genPath), Buffer.from("stub"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 40 });
    await adapter.init();
    await assert.rejects(
      () => adapter.get(key),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
  });

  it("K4: sync-root guard uses home anchors and avoids false positives", () => {
    const home = os.homedir();
    assert.equal(isKnownSyncedFolderRoot(path.join(home, "Library", "CloudStorage", "OneDrive-Personal")), true);
    assert.equal(isKnownSyncedFolderRoot("/home/w/src/OneDrive/fixtures"), false);
    assert.throws(
      () => assertLocalObjectStoreRootNotSynced(path.join(home, "Dropbox", "vault")),
      (err) => err instanceof StorageError,
    );
  });

  it("CAS bootstrap restores PR #25 error when no snapshot verifies", async () => {
    const { createMemoryStorageAdapter } = await import("../../lib/storage/memory-adapter.mjs");
    const { pickVerifiedBootstrapSnapshot } = await import("../../lib/storage/storage-compaction.mjs");
    const { createEmptyStorageManifest } = await import("../../lib/storage/storage-manifest.mjs");
    const { snapEncRelativePath } = await import("../../lib/storage/layout.mjs");
    const { wrapStorageSnapshotPlain, SNAPSHOT_FORMAT } = await import("../../lib/storage/storage-compaction.mjs");
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const ctx = syncCtx(adapter, DEVICE_A);
    const snapKey = snapEncRelativePath(PREFIX, 0);
    const snapBody = sealLayoutObjectPlaintext(
      DEK,
      snapKey,
      wrapStorageSnapshotPlain({
        format: SNAPSHOT_FORMAT,
        epoch: 0,
        created_at: new Date().toISOString(),
        compacted_through: normalizeVectorSyncCursor(0),
        trusted_heads: {
          [deriveDevH(DEK, DEVICE_A)]: { seq: 5, digest: "deadbeef".repeat(8) },
        },
        replica: {},
      }),
    );
    await adapter.put(snapKey, snapBody, { ifNoneMatch: "*" });
    const manifest = createEmptyStorageManifest();
    manifest.latest_snapshot_epoch = 0;
    await assert.rejects(
      () => pickVerifiedBootstrapSnapshot(ctx, manifest, ctx.localState.load()),
      /No verified snapshot satisfies manifest compaction floor/,
    );
  });

  it("migration: legacy ic_layout_device_sync_v1 sidecar loads on folder without corrupt_storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-k-migrate-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
    await adapter.init();
    const key = deviceEncRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A));
    const legacy = sealLayoutObjectPlaintext(
      DEK,
      key,
      wrapDeviceSyncAckPlain({
        dev: DEVICE_A,
        acknowledged_seq: 2,
        acknowledged_cursor: normalizeVectorSyncCursor(0),
        updated_at: new Date().toISOString(),
      }),
    );
    await adapter.put(key, legacy, { ifNoneMatch: "*" });
    const merged = await loadFolderMergedManifest(adapter, DEK, PREFIX);
    assert.equal(merged.devices.length, 1);
    assert.equal(merged.devices[0].acknowledged_seq, 2);
  });
});
