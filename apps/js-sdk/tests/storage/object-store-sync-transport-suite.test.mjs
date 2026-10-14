import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const TEST_DEK = new Uint8Array(32).fill(11);
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const DEVICE_C = "33333333-3333-4333-8333-333333333333";
const LAYOUT_PREFIX = "accounts/test";

/** @param {string} deviceUuid */
function createTransport(adapter, deviceUuid, hooks = {}) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT_PREFIX,
    ...hooks,
  });
}

async function pushCreate(transport, metadata = { title: "ctx" }) {
  const client_id = generateClientNodeId();
  return transport.pushSyncMutations([
    {
      client_id,
      op: "context_create",
      payload: { metadata },
    },
  ]);
}

describe("ObjectStoreSyncTransport log sync", () => {
  it("converges two devices through pull/push", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = createTransport(adapter, DEVICE_A);
    const b = createTransport(adapter, DEVICE_B);

    const pushed = await pushCreate(a);
    assert.equal(pushed.applied.length, 1);

    const pulled = await b.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
    assert.equal(pulled.changes.length, 1);
    assert.equal(pulled.changes[0].op, "context_create");

    const reply = await pushCreate(b, { title: "from-b" });
    assert.equal(reply.applied.length, 1);

    const catchUp = await a.pullSyncChanges({ since: pulled.next_since, limit: 100 });
    assert.equal(catchUp.changes.length, 1);
    assert.equal(catchUp.changes[0].payload.metadata.title, "from-b");
  });

  it("converges three devices", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = createTransport(adapter, DEVICE_A);
    const b = createTransport(adapter, DEVICE_B);
    const c = createTransport(adapter, DEVICE_C);

    await pushCreate(a);
    let cursorB = normalizeVectorSyncCursor(0);
    let cursorC = normalizeVectorSyncCursor(0);
    await b.pullSyncChanges({ since: cursorB, limit: 100 });
    await c.pullSyncChanges({ since: cursorC, limit: 100 });
    await pushCreate(b);
    await pushCreate(c);
    const finalA = await a.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 100 });
    assert.ok(finalA.changes.length >= 2);
  });

  it("resumes pull from vector cursor", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = createTransport(adapter, DEVICE_A);
    const b = createTransport(adapter, DEVICE_B);

    await pushCreate(a);
    await pushCreate(a, { title: "second" });
    let cursor = normalizeVectorSyncCursor(0);
    const page1 = await b.pullSyncChanges({ since: cursor, limit: 1 });
    assert.equal(page1.changes.length, 1);
    cursor = page1.next_since;
    const page2 = await b.pullSyncChanges({ since: cursor, limit: 10 });
    assert.equal(page2.changes.length, 1);
  });

  it("maps duplicate push by client_id", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = createTransport(adapter, DEVICE_A);
    const client_id = generateClientNodeId();
    const mutation = {
      client_id,
      op: "context_create",
      payload: { metadata: { title: "once" } },
    };
    const first = await a.pushSyncMutations([mutation]);
    assert.deepEqual(first.duplicate, []);
    const second = await a.pushSyncMutations([mutation]);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.duplicate, [client_id]);
  });

  it("crash hook fires after segment write before outbox clear", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    let hookCalls = 0;
    const a = createTransport(adapter, DEVICE_A, {
      testHookAfterSegmentWrite: () => {
        hookCalls += 1;
      },
    });
    await a.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { title: "crash-test" } },
      },
    ]);
    assert.equal(hookCalls, 1);
  });
});
