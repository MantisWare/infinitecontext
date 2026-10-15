import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import { gcLogSegmentsCoveredByCompaction } from "../../lib/storage/storage-compaction.mjs";
import { loadStorageManifest } from "../../lib/storage/storage-manifest.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { SimulatedEventualCopier } from "./helpers/folder-eventual-copier.mjs";

const TEST_DEK = new Uint8Array(32).fill(7);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT_PREFIX = "accounts/folder-rand";

function createTransport(adapter, deviceUuid, localState = createInMemoryObjectStoreLocalState()) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT_PREFIX,
    localState,
  });
}

async function pushCreate(transport, tag) {
  const client_id = generateClientNodeId();
  const result = await transport.pushSyncMutations([
    {
      client_id,
      op: "context_create",
      payload: { metadata: { tag } },
    },
  ]);
  return result;
}

describe("folder random schedule convergence", () => {
  it("two devices converge with delayed sync and GC stays disabled", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fr-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fr-b-"));
    const adapterA = createFolderStorageAdapter({ rootDir: dirA, placeholderTimeoutMs: 150 });
    const adapterB = createFolderStorageAdapter({ rootDir: dirB, placeholderTimeoutMs: 150 });
    await adapterA.init();
    await adapterB.init();
    const copier = new SimulatedEventualCopier(dirA, dirB);
    const transportA = createTransport(adapterA, DEVICE_A);
    const transportB = createTransport(adapterB, DEVICE_B);

    const schedule = [
      async () => pushCreate(transportA, "a1"),
      async () => copier.sync("AtoB", { delayMs: 3, shuffle: true }),
      async () => transportB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 50 }),
      async () => pushCreate(transportB, "b1"),
      async () => copier.sync("BtoA", { delayMs: 4, shuffle: true }),
      async () => copier.sync("AtoB", { delayMs: 2, shuffle: true }),
      async () => transportA.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 }),
      async () => transportB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 }),
    ];
    for (const step of schedule) {
      await step();
    }

    const { deriveDevH } = await import("../../lib/storage/layout.mjs");
    const gc = await gcLogSegmentsCoveredByCompaction(
      {
        adapter: adapterA,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, DEVICE_A),
        deviceUuid: DEVICE_A,
        localState: createInMemoryObjectStoreLocalState(),
      },
      await loadStorageManifest(adapterA, TEST_DEK, LAYOUT_PREFIX),
    );
    assert.equal(gc.deleted, 0);

    const verifyA = createTransport(adapterA, DEVICE_A);
    const verifyB = createTransport(adapterB, DEVICE_B);
    const finalA = await verifyA.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
    const finalB = await verifyB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
    const tagsA = finalA.changes.map((c) => c.payload?.metadata?.tag).filter(Boolean);
    const tagsB = finalB.changes.map((c) => c.payload?.metadata?.tag).filter(Boolean);
    for (const tag of ["a1", "b1"]) {
      assert.ok(tagsA.includes(tag), `A missing ${tag}`);
      assert.ok(tagsB.includes(tag), `B missing ${tag}`);
    }
  });
});
