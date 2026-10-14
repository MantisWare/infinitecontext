import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import {
  applySortedMutationsToReplica,
  permuteMutationBatches,
  sortMergeableMutations,
} from "../../lib/object-store-merge.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const TEST_DEK = new Uint8Array(32).fill(11);
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const DEVICE_C = "33333333-3333-4333-8333-333333333333";
const LAYOUT_PREFIX = "accounts/test";

/**
 * @param {import('../../lib/storage/types.mjs').StorageAdapter} adapter
 * @param {string} deviceUuid
 * @param {ReturnType<typeof createInMemoryObjectStoreLocalState>} [localState]
 */
function createTransport(adapter, deviceUuid, localState = createInMemoryObjectStoreLocalState()) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT_PREFIX,
    localState,
  });
}

async function pushCreate(transport, metadata = { source: "test" }) {
  const client_id = generateClientNodeId();
  return transport.pushSyncMutations([
    {
      client_id,
      op: "context_create",
      payload: { metadata },
    },
  ]);
}

/** @param {string} label @param {() => Promise<import('../../lib/storage/types.mjs').StorageAdapter>} factory */
function registerTransportSuite(label, factory) {
  describe(`ObjectStoreSyncTransport log sync (${label})`, () => {
    it("converges two devices through pull/push", async () => {
      const adapter = await factory();
      const a = createTransport(adapter, DEVICE_A);
      const b = createTransport(adapter, DEVICE_B);

      const pushed = await pushCreate(a);
      assert.equal(pushed.applied.length, 1);

      const pulled = await b.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
      assert.equal(pulled.changes.length, 1);
      assert.equal(pulled.changes[0].op, "context_create");

      const reply = await pushCreate(b, { source: "from-b" });
      assert.equal(reply.applied.length, 1);

      const catchUp = await a.pullSyncChanges({ since: pulled.next_since, limit: 100 });
      assert.equal(catchUp.changes.length, 1);
      assert.equal(catchUp.changes[0].payload.metadata.source, "from-b");
    });

    it("converges three devices", async () => {
      const adapter = await factory();
      const a = createTransport(adapter, DEVICE_A);
      const b = createTransport(adapter, DEVICE_B);
      const c = createTransport(adapter, DEVICE_C);

      await pushCreate(a);
      await b.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
      await c.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
      await pushCreate(b);
      await pushCreate(c);
      const finalA = await a.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
      assert.ok(finalA.changes.length >= 2);
    });

    it("resumes pull from vector cursor by whole segments", async () => {
      const adapter = await factory();
      const a = createTransport(adapter, DEVICE_A);
      const b = createTransport(adapter, DEVICE_B);

      await pushCreate(a);
      await pushCreate(a, { source: "second" });
      let cursor = normalizeVectorSyncCursor(0);
      const page1 = await b.pullSyncChanges({ since: cursor, limit: 1 });
      assert.equal(page1.changes.length, 1);
      cursor = page1.next_since;
      const page2 = await b.pullSyncChanges({ since: cursor, limit: 10 });
      assert.equal(page2.changes.length, 1);
    });

    it("maps duplicate push by client_id", async () => {
      const adapter = await factory();
      const a = createTransport(adapter, DEVICE_A);
      const client_id = generateClientNodeId();
      const mutation = {
        client_id,
        op: "context_create",
        payload: { metadata: { source: "once" } },
      };
      const first = await a.pushSyncMutations([mutation]);
      assert.deepEqual(first.duplicate, []);
      const second = await a.pushSyncMutations([mutation]);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.duplicate, [client_id]);
    });

    it("recovers after crash between segment write and local commit", async () => {
      const adapter = await factory();
      const local = createInMemoryObjectStoreLocalState();
      const client_id = generateClientNodeId();
      const mutation = {
        client_id,
        op: "context_create",
        payload: { metadata: { source: "crash-test" } },
      };
      const crashed = new ObjectStoreSyncTransport(adapter, {
        dek: TEST_DEK,
        deviceUuid: DEVICE_A,
        layoutPrefix: LAYOUT_PREFIX,
        localState: local,
        testHookAfterSegmentWrite: () => {},
        testHookSkipLocalSaveAfterSegmentWrite: true,
      });
      await crashed.pushSyncMutations([mutation]);
      const recovered = createTransport(adapter, DEVICE_A, local);
      const retry = await recovered.pushSyncMutations([mutation]);
      assert.deepEqual(retry.applied, []);
      assert.deepEqual(retry.duplicate, [client_id]);
    });
  });
}

registerTransportSuite("memory", async () => {
  const adapter = createMemoryStorageAdapter();
  await adapter.init();
  return adapter;
});

registerTransportSuite("filesystem", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-os-sync-"));
  const adapter = createFilesystemStorageAdapter({ rootDir: root, id: "fs-test" });
  await adapter.init();
  return adapter;
});

describe("ObjectStoreSyncTransport merge property", () => {
  it("permutes segment batches and clock skew to the same replica", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = createTransport(adapter, DEVICE_A);
    const b = createTransport(adapter, DEVICE_B);
    await pushCreate(a);
    await pushCreate(b, { source: "b" });
    await a.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 50 });

    /** @type {import('../../lib/object-store-merge.mjs').MergeableMutation[]} */
    const items = [
      {
        hlc: "2026-01-01T00:00:00.000Z#0",
        devH: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
        seq: 0,
        index: 0,
        mutation: { op: "context_create", client_id: "icn_" + "a".repeat(24), payload: { metadata: { source: "x" } } },
        deviceUuid: DEVICE_A,
        segmentCreatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hlc: "2025-01-01T00:00:00.000Z#0",
        devH: "BBBBBBBBBBBBBBBBBBBBBBBBBB",
        seq: 0,
        index: 0,
        mutation: { op: "context_create", client_id: "icn_" + "b".repeat(24), payload: { metadata: { source: "y" } } },
        deviceUuid: DEVICE_B,
        segmentCreatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    const batches = permuteMutationBatches(items, 2);
    const replicas = batches.map((batch) => {
      const replica = new Map();
      applySortedMutationsToReplica(replica, sortMergeableMutations(batch.flat()));
      return replica;
    });
    assert.deepEqual([...replicas[0].keys()].sort(), [...replicas[1].keys()].sort());
  });
});
