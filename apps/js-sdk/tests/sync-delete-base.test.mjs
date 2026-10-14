import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../lib/ic-crypto.mjs";
import { mutationForMessageDelete, resolveDeleteBaseSequence } from "../lib/sync-engine.mjs";
import { normalizeVectorSyncCursor } from "../lib/sync-cursor.mjs";
import { createInMemoryObjectStoreLocalState } from "../lib/object-store-local-sync-state.mjs";
import { snapshotVectorCursor } from "../lib/object-store-delete-stale.mjs";
import { createMemoryStorageAdapter } from "../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../lib/storage/object-store-sync-transport.mjs";

describe("message_delete base_sequence", () => {
  it("resolveDeleteBaseSequence never returns server head fallback", () => {
    assert.equal(resolveDeleteBaseSequence({ explicitBaseSequence: 12 }), 12);
    assert.equal(resolveDeleteBaseSequence({}), null);
    const vector = resolveDeleteBaseSequence({
      localCursor: { kind: "vector", v: { ABCDEFGHJKMNPQRSTVWXYZ2345: 2 } },
    });
    assert.equal(vector.kind, "vector");
    assert.equal(vector.v.ABCDEFGHJKMNPQRSTVWXYZ2345, 2);
  });

  it("object store head_sequence reflects trusted heads after first segment", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const dek = new Uint8Array(32).fill(8);
    const transport = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: "77777777-7777-4777-8777-777777777777",
      layoutPrefix: "accounts/head-seq",
      localState: createInMemoryObjectStoreLocalState(),
    });
    await transport.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { source: "head" } },
      },
    ]);
    const status = await transport.fetchSyncStatus();
    assert.equal(status.head_sequence, 0);
    await transport.pushSyncMutations([
      {
        client_id: generateClientNodeId(),
        op: "context_create",
        payload: { metadata: { source: "head2" } },
      },
    ]);
    const after = await transport.fetchSyncStatus();
    assert.equal(after.head_sequence, 1);
  });

  it("mutationForMessageDelete carries explicit base_vector snapshot", () => {
    const base_vector = { kind: "vector", v: { ABCDEFGHJKMNPQRSTVWXYZ2345: 2 } };
    const mutation = mutationForMessageDelete("ctx_test", [0], { base_sequence: 7, base_vector });
    assert.equal(mutation.base_sequence, 7);
    assert.deepEqual(mutation.base_vector.v, base_vector.v);
    assert.equal(mutation.op, "message_delete");
  });

  it("object store transport rejects message_delete without base_vector", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const dek = new Uint8Array(32).fill(4);
    const transport = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: "44444444-4444-4444-8444-444444444444",
      layoutPrefix: "accounts/delete-base",
      localState: createInMemoryObjectStoreLocalState(),
    });
    const createId = generateClientNodeId();
    const contextId = "ctx_delete_base";
    await transport.pushSyncMutations([
      {
        client_id: createId,
        op: "context_create",
        context_id: contextId,
        payload: { metadata: { source: "test" }, context_id: contextId },
      },
    ]);
    const msgId = generateClientNodeId();
    await transport.pushSyncMutations([
      {
        client_id: msgId,
        op: "message_append",
        context_id: contextId,
        payload: {
          messages: [{ id: msgId, role: "user", content: { body: "hi" }, metadata: { ic_client_node_id: msgId } }],
        },
      },
    ]);
    const delClient = generateClientNodeId();
    const result = await transport.pushSyncMutations([
      {
        client_id: delClient,
        op: "message_delete",
        context_id: contextId,
        base_sequence: 0,
        payload: { ids: [msgId] },
      },
    ]);
    assert.ok(
      result.failed?.some(
        (f) => f.code === "invalid_input" && f.client_id === delClient && /base_vector/.test(String(f.message)),
      ),
    );
  });

  it("object store transport records delete_stale_base conflict", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const dek = new Uint8Array(32).fill(5);
    const deviceA = "55555555-5555-4555-8555-555555555555";
    const deviceB = "66666666-6666-4666-8666-666666666666";
    const transportA = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: deviceA,
      layoutPrefix: "accounts/stale-base",
      localState: createInMemoryObjectStoreLocalState(),
    });
    const localB = createInMemoryObjectStoreLocalState();
    const transportB = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: deviceB,
      layoutPrefix: "accounts/stale-base",
      localState: localB,
    });
    const createId = generateClientNodeId();
    const contextId = "ctx_stale_base";
    await transportA.pushSyncMutations([
      {
        client_id: createId,
        op: "context_create",
        context_id: contextId,
        payload: { metadata: { source: "test" }, context_id: contextId },
      },
    ]);
    let cursorB = normalizeVectorSyncCursor(0);
    const pullCreate = await transportB.pullSyncChanges({ since: cursorB, limit: 50 });
    cursorB = pullCreate.next_since;
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
    const pullAppend = await transportB.pullSyncChanges({ since: cursorB, limit: 50 });
    cursorB = pullAppend.next_since;
    const statusBeforeUpdate = await transportB.fetchSyncStatus();
    const baseSeq = Number(statusBeforeUpdate.head_sequence);
    const planVector = snapshotVectorCursor(localB.load().vectorCursor);
    const m2 = generateClientNodeId();
    await transportA.pushSyncMutations([
      {
        client_id: m2,
        op: "message_update",
        context_id: contextId,
        payload: {
          messages: [{ id: m1, role: "user", content: { body: "changed" }, metadata: { ic_client_node_id: m1 } }],
        },
      },
    ]);
    const pullUpdate = await transportB.pullSyncChanges({ since: cursorB, limit: 50 });
    cursorB = pullUpdate.next_since;
    const delClient = generateClientNodeId();
    const stale = await transportB.pushSyncMutations([
      {
        client_id: delClient,
        op: "message_delete",
        context_id: contextId,
        base_sequence: baseSeq,
        base_vector: planVector,
        payload: { ids: [m1] },
      },
    ]);
    assert.ok(
      stale.conflicts.some(
        (c) => c.kind === "delete_stale_base" && c.client_id === delClient && c.id.startsWith("delete_stale_base:"),
      ),
    );
  });
});
