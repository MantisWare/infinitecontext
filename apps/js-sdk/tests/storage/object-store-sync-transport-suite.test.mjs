import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import {
  deriveDevH,
  encryptLogSegment,
  layoutSegmentEnvelopeDigest,
  logSegmentRelativePath,
} from "../../lib/storage/layout.mjs";
import {
  applySortedMutationsToReplica,
  permuteMutationBatches,
  sortMergeableMutations,
} from "../../lib/object-store-merge.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  resetObjectStoreSyncSegmentWriteHooksForTests,
  setObjectStoreSyncSegmentWriteHooksForTests,
} from "../../lib/object-store-sync.mjs";
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
      setObjectStoreSyncSegmentWriteHooksForTests({
        afterSegmentWrite: () => {},
        skipLocalSaveAfterSegmentWrite: true,
      });
      try {
        const crashed = new ObjectStoreSyncTransport(adapter, {
          dek: TEST_DEK,
          deviceUuid: DEVICE_A,
          layoutPrefix: LAYOUT_PREFIX,
          localState: local,
        });
        await crashed.pushSyncMutations([mutation]);
      } finally {
        resetObjectStoreSyncSegmentWriteHooksForTests();
      }
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

registerTransportSuite("folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-sync-"));
  const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 200 });
  await adapter.init();
  return adapter;
});

/**
 * @param {import('../../lib/storage/types.mjs').StorageAdapter} adapter
 * @param {number} seq
 * @param {string} prevDigest
 */
async function writeDirectLogSegment(adapter, seq, prevDigest) {
  const devH = deriveDevH(TEST_DEK, DEVICE_A);
  const record = {
    dev: DEVICE_A,
    seq,
    prev_digest: prevDigest,
    created_at: new Date().toISOString(),
    mutations: [
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { source: `bulk-${seq}` } },
        hlc: { wall_ms: seq, counter: 0 },
      },
    ],
  };
  const envelope = encryptLogSegment(TEST_DEK, devH, record);
  const key = logSegmentRelativePath(LAYOUT_PREFIX, devH, seq);
  const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
    ic_layout_segment_envelope_v1: envelope,
  });
  await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
  return layoutSegmentEnvelopeDigest(envelope);
}

/** @param {import('../../lib/storage/types.mjs').StorageAdapter} adapter @param {number} count */
async function seedDirectLogSegments(adapter, count) {
  let prevDigest = "";
  for (let seq = 0; seq < count; seq += 1) {
    prevDigest = await writeDirectLogSegment(adapter, seq, prevDigest);
  }
  return prevDigest;
}

describe("ObjectStoreSyncTransport merge property", () => {
  it("2400-segment pull uses cached trusted prefix on incremental sync", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    await seedDirectLogSegments(adapter, 2400);

    const readerLocal = createInMemoryObjectStoreLocalState();
    const reader = createTransport(adapter, DEVICE_B, readerLocal);
    let since = normalizeVectorSyncCursor(0);
    let total = 0;
    const initialPullStarted = Date.now();
    for (;;) {
      const page = await reader.pullSyncChanges({ since, limit: 100 });
      total += page.changes.length;
      since = page.next_since;
      if (!page.has_more) break;
    }
    const elapsedInitialPull = Date.now() - initialPullStarted;
    assert.equal(total, 2400);
    assert.ok(elapsedInitialPull < 300_000, `initial pull took ${elapsedInitialPull}ms`);

    const devH = deriveDevH(TEST_DEK, DEVICE_A);
    const trusted = readerLocal.load().trustedHeads[devH];
    assert.ok(trusted);
    await writeDirectLogSegment(adapter, trusted.seq + 1, trusted.digest);

    const incrementalStarted = Date.now();
    const tailPage = await reader.pullSyncChanges({ since: readerLocal.load().vectorCursor, limit: 50 });
    const elapsedIncremental = Date.now() - incrementalStarted;
    assert.equal(tailPage.changes.length, 1);
    assert.ok(elapsedIncremental < 15_000, `incremental pull took ${elapsedIncremental}ms`);
  });
});
