import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { snapshotVectorCursor } from "../../lib/object-store-delete-stale.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

describe("object store delete stale race", () => {
  it("records stale delete when update exists locally but unpulled on another device view", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const dek = new Uint8Array(32).fill(2);
    const deviceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const deviceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const localB = createInMemoryObjectStoreLocalState();
    const transportA = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: deviceA,
      layoutPrefix: "accounts/delete-race",
      localState: createInMemoryObjectStoreLocalState(),
    });
    const transportB = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: deviceB,
      layoutPrefix: "accounts/delete-race",
      localState: localB,
    });
    const contextId = "ctx_delete_race";
    const createId = generateClientNodeId();
    await transportA.pushSyncMutations([
      {
        client_id: createId,
        op: "context_create",
        context_id: contextId,
        payload: { context_id: contextId, metadata: { source: "test" } },
      },
    ]);
    let cursor = normalizeVectorSyncCursor(0);
    await transportB.pullSyncChanges({ since: cursor, limit: 50 });
    const m1 = generateClientNodeId();
    await transportA.pushSyncMutations([
      {
        client_id: m1,
        op: "message_append",
        context_id: contextId,
        payload: {
          messages: [{ id: m1, role: "user", content: { body: "one" }, metadata: { ic_client_node_id: m1 } }],
        },
      },
    ]);
    await transportB.pullSyncChanges({ since: localB.load().vectorCursor, limit: 50 });
    const planVector = snapshotVectorCursor(localB.load().vectorCursor);
    const baseSeq = (await transportB.fetchSyncStatus()).head_sequence;
    await transportA.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "message_update",
        context_id: contextId,
        payload: {
          messages: [{ id: m1, role: "user", content: { body: "changed" }, metadata: { ic_client_node_id: m1 } }],
        },
      },
    ]);
    // B does not pull the update; delete planned against old vector base.
    const del = await transportB.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "message_delete",
        context_id: contextId,
        base_sequence: baseSeq,
        base_vector: planVector,
        payload: { ids: [m1] },
      },
    ]);
    assert.equal(del.applied.length, 0);
    assert.ok(del.conflicts.some((c) => c.kind === "delete_stale_base"));
  });
});
