import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import {
  loadFolderMergedManifest,
  mergeMaxDeviceContributionPair,
  wrapDeviceManifestContribution,
} from "../../lib/storage/storage-manifest-folder.mjs";
import { sealLayoutObjectPlaintext } from "../../lib/storage/storage-cas-rmw.mjs";
import { deriveDevH, deviceEncRelativePath } from "../../lib/storage/layout.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";

const DEK = new Uint8Array(32).fill(3);
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEV_A = deriveDevH(DEK, UUID_A);
const DEV_B = deriveDevH(DEK, UUID_B);
const PREFIX = "accounts/merge-test";

describe("folder merged manifest", () => {
  it("unions participants and maxes snapshot epoch from device files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-merge-manifest-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 100 });
    await adapter.init();
    const keyA = deviceEncRelativePath(PREFIX, DEV_A);
    const keyB = deviceEncRelativePath(PREFIX, DEV_B);
    const bodyA = sealLayoutObjectPlaintext(
      DEK,
      keyA,
      wrapDeviceManifestContribution({
        devH: DEV_A,
        record_generation: 1,
        sync_participant: true,
        last_seq: 2,
        acknowledged_seq: 2,
        latest_snapshot_epoch: 4,
        compacted_through: normalizeVectorSyncCursor(0),
        removed_devices: [],
        trusted_head: { seq: 2, digest: "aa" },
      }),
    );
    const bodyB = sealLayoutObjectPlaintext(
      DEK,
      keyB,
      wrapDeviceManifestContribution({
        devH: DEV_B,
        record_generation: 1,
        sync_participant: true,
        last_seq: 1,
        acknowledged_seq: 1,
        latest_snapshot_epoch: 3,
        compacted_through: normalizeVectorSyncCursor(0),
        removed_devices: [],
        trusted_head: { seq: 1, digest: "bb" },
      }),
    );
    await adapter.put(keyA, bodyA, { ifNoneMatch: "*" });
    await adapter.put(keyB, bodyB, { ifNoneMatch: "*" });
    const merged = await loadFolderMergedManifest(adapter, DEK, PREFIX);
    assert.equal(merged.latest_snapshot_epoch, 4);
    assert.deepEqual(new Set(merged.sync_participants), new Set([DEV_A, DEV_B]));
    assert.equal(merged.devices.length, 2);
  });

  it("mergeMax rejects conflicting trusted head digests at same seq", () => {
    assert.throws(() =>
      mergeMaxDeviceContributionPair(
        {
          devH: DEV_A,
          record_generation: 1,
          sync_participant: true,
          last_seq: 1,
          acknowledged_seq: 1,
          latest_snapshot_epoch: 0,
          compacted_through: normalizeVectorSyncCursor(0),
          removed_devices: [],
          trusted_head: { seq: 2, digest: "x" },
        },
        {
          devH: DEV_A,
          record_generation: 2,
          sync_participant: true,
          last_seq: 1,
          acknowledged_seq: 1,
          latest_snapshot_epoch: 0,
          compacted_through: normalizeVectorSyncCursor(0),
          removed_devices: [],
          trusted_head: { seq: 2, digest: "y" },
        },
      ),
    );
  });
});
