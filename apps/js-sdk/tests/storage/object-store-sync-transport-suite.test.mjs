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
  it("pull/push 600 segments within timing sanity bound", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const local = createInMemoryObjectStoreLocalState();
    const transport = createTransport(adapter, DEVICE_A, local);
    const started = Date.now();
    for (let i = 0; i < 600; i += 1) {
      await transport.pushSyncMutations([
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { source: `bulk-${i}` } },
        },
      ]);
    }
    const elapsedPush = Date.now() - started;
    assert.ok(elapsedPush < 120_000, `push took ${elapsedPush}ms`);

    const reader = createTransport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState());
    const pullStarted = Date.now();
    let since = normalizeVectorSyncCursor(0);
    let total = 0;
    for (;;) {
      const page = await reader.pullSyncChanges({ since, limit: 50 });
      total += page.changes.length;
      since = page.next_since;
      if (!page.has_more) break;
    }
    const elapsedPull = Date.now() - pullStarted;
    assert.equal(total, 600);
    assert.ok(elapsedPull < 120_000, `pull took ${elapsedPull}ms`);
  });
});
