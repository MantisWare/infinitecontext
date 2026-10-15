import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { applySyncChangeToReplica } from "../../lib/sync-engine.mjs";
import { snapshotVectorCursor } from "../../lib/object-store-delete-stale.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const TEST_DEK = new Uint8Array(32).fill(19);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT = "accounts/replica-batch";

function transport(adapter, deviceUuid, localState) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT,
    localState,
  });
}

async function pullInBatches(transport, batchSize) {
  /** @type {object[]} */
  const changes = [];
  let since = normalizeVectorSyncCursor(0);
  for (;;) {
    const page = await transport.pullSyncChanges({ since, limit: batchSize });
    changes.push(...page.changes);
    since = page.next_since;
    if (!page.has_more) break;
  }
  return changes;
}

function replicaFromChanges(changes) {
  const replica = { contexts: {}, messages: {}, sync_conflicts: [] };
  for (const change of changes) {
    applySyncChangeToReplica(replica, change, () => {});
  }
  return replica;
}

describe("replica tombstone + batch convergence", () => {
  it("1-batch and 3-batch pulls produce identical replicas", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = transport(adapter, DEVICE_A, createInMemoryObjectStoreLocalState());
    const ctx = "ctx_batch";
    const msg = generateClientNodeId();
    await writer.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        context_id: ctx,
        payload: { context_id: ctx, metadata: { source: "batch" } },
      },
      {
        client_id: msg,
        op: "message_append",
        context_id: ctx,
        payload: {
          messages: [{ id: msg, role: "user", content: { body: "v1" }, metadata: { ic_client_node_id: msg } }],
        },
      },
    ]);
    const msg2 = generateClientNodeId();
    await writer.pushSyncMutations([
      {
        client_id: msg2,
        op: "message_append",
        context_id: ctx,
        payload: {
          messages: [{ id: msg2, role: "user", content: { body: "two" }, metadata: { ic_client_node_id: msg2 } }],
        },
      },
    ]);

    const oneBatch = replicaFromChanges(await pullInBatches(transport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState()), 500));
    const threeBatch = replicaFromChanges(await pullInBatches(transport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState()), 1));

    assert.deepEqual(oneBatch.messages, threeBatch.messages);
    assert.deepEqual(Object.keys(oneBatch.contexts).sort(), Object.keys(threeBatch.contexts).sort());
  });

  it("delete tombstone blocks later update with deterministic conflict", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const localA = createInMemoryObjectStoreLocalState();
    const writer = transport(adapter, DEVICE_A, localA);
    const ctx = "ctx_tombstone";
    const msg = generateClientNodeId();
    await writer.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        context_id: ctx,
        payload: { context_id: ctx, metadata: {} },
      },
    ]);
    await writer.pushSyncMutations([
      {
        client_id: msg,
        op: "message_append",
        context_id: ctx,
        payload: {
          messages: [{ id: msg, role: "user", content: { body: "v1" }, metadata: { ic_client_node_id: msg } }],
        },
      },
    ]);
    const base = snapshotVectorCursor(localA.load().vectorCursor);
    const lateUpdateBase = snapshotVectorCursor(localA.load().vectorCursor);
    await writer.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "message_delete",
        context_id: ctx,
        base_sequence: 1,
        base_vector: base,
        payload: { ids: [msg] },
      },
    ]);
    await writer.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "message_update",
        context_id: ctx,
        base_vector: lateUpdateBase,
        payload: {
          messages: [{ id: msg, role: "user", content: { body: "late" }, metadata: { ic_client_node_id: msg } }],
          base_vector: lateUpdateBase,
        },
      },
    ]);
    const changes = await pullInBatches(transport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState()), 2);
    const replica = replicaFromChanges(changes);
    assert.equal(replica.messages[msg]?.tombstone, true);
    assert.ok(replica.sync_conflicts.some((c) => c.kind === "tombstone_blocked_update"));
  });
});
