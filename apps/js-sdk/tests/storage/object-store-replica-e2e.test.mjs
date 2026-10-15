import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { applySyncChangeToReplica } from "../../lib/sync-engine.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const TEST_DEK = new Uint8Array(32).fill(7);
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LAYOUT = "accounts/replica-e2e";

function transport(adapter, deviceUuid, localState) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT,
    localState,
  });
}

async function pullAll(transport, since) {
  /** @type {object[]} */
  const changes = [];
  let cursor = since;
  for (;;) {
    const page = await transport.pullSyncChanges({ since: cursor, limit: 50 });
    changes.push(...page.changes);
    cursor = page.next_since;
    if (!page.has_more) break;
  }
  return changes;
}

function buildReplica(changes) {
  const replica = { contexts: {}, messages: {} };
  for (const change of changes) {
    applySyncChangeToReplica(replica, change, () => {});
  }
  return replica;
}

describe("object store replica consumer e2e", () => {
  it("B and D converge with opposite pull orders through applySyncChangeToReplica", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const bWriter = transport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState());
    const dWriter = transport(adapter, DEVICE_D, createInMemoryObjectStoreLocalState());

    const ctx = "ctx_replica_e2e";
    const m1 = generateClientNodeId();
    await bWriter.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        context_id: ctx,
        payload: { context_id: ctx, metadata: { source: "b" } },
      },
      {
        client_id: m1,
        op: "message_append",
        context_id: ctx,
        payload: {
          messages: [{ id: m1, role: "user", content: { body: "hello" }, metadata: { ic_client_node_id: m1 } }],
        },
      },
    ]);
    const m2 = generateClientNodeId();
    await dWriter.pushSyncMutations([
      {
        client_id: m2,
        op: "message_append",
        context_id: ctx,
        payload: {
          messages: [{ id: m2, role: "user", content: { body: "from-d" }, metadata: { ic_client_node_id: m2 } }],
        },
      },
    ]);

    const bT = transport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState());
    const dT = transport(adapter, DEVICE_D, createInMemoryObjectStoreLocalState());
    const forward = await pullAll(bT, normalizeVectorSyncCursor(0));
    const reverse = (await pullAll(dT, normalizeVectorSyncCursor(0))).reverse();

    const replicaForward = buildReplica(forward);
    const replicaReverse = buildReplica(reverse);
    assert.deepEqual(Object.keys(replicaForward.messages).sort(), Object.keys(replicaReverse.messages).sort());
    assert.equal(replicaForward.messages[m1]?.payload?.content?.body, "hello");
    assert.equal(replicaReverse.messages[m2]?.payload?.content?.body, "from-d");
  });
});
