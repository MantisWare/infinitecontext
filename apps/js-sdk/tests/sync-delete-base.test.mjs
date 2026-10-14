import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../lib/ic-crypto.mjs";
import { mutationForMessageDelete, resolveDeleteBaseSequence } from "../lib/sync-engine.mjs";
import { normalizeVectorSyncCursor } from "../lib/sync-cursor.mjs";
import { createMemoryStorageAdapter } from "../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../lib/storage/object-store-sync-transport.mjs";

describe("message_delete base_sequence", () => {
  it("resolveDeleteBaseSequence never returns server head fallback", () => {
    assert.equal(resolveDeleteBaseSequence({ explicitBaseSequence: 12 }), 12);
    assert.equal(resolveDeleteBaseSequence({}), null);
  });

  it("mutationForMessageDelete throws without a known base", () => {
    assert.throws(
      () => mutationForMessageDelete("ctx_test", ["icn_" + "a".repeat(24)]),
      /base_sequence is required/,
    );
  });

  it("mutationForMessageDelete accepts explicit base_sequence", () => {
    const mutation = mutationForMessageDelete("ctx_test", [0], { base_sequence: 7 });
    assert.equal(mutation.base_sequence, 7);
    assert.equal(mutation.op, "message_delete");
  });

  it("object store transport rejects message_delete without base_sequence", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const dek = new Uint8Array(32).fill(4);
    const transport = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: "44444444-4444-4444-8444-444444444444",
      layoutPrefix: "accounts/delete-base",
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
          messages: [{ id: msgId, role: "user", content: { message: "hi" }, metadata: { ic_client_node_id: msgId } }],
        },
      },
    ]);
    const delClient = generateClientNodeId();
    const result = await transport.pushSyncMutations([
      {
        client_id: delClient,
        op: "message_delete",
        context_id: contextId,
        payload: { ids: [msgId] },
      },
    ]);
    assert.ok(result.failed?.some((f) => f.code === "invalid_input" && f.client_id === delClient));
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
    });
    const transportB = new ObjectStoreSyncTransport(adapter, {
      dek,
      deviceUuid: deviceB,
      layoutPrefix: "accounts/stale-base",
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
    await transportB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 50 });
    const m1 = generateClientNodeId();
    await transportA.pushSyncMutations([
      {
        client_id: m1,
        op: "message_append",
        context_id: contextId,
        payload: {
          messages: [{ id: m1, role: "user", content: { message: "one" }, metadata: { ic_client_node_id: m1 } }],
        },
      },
    ]);
    await transportB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 50 });
    const status = await transportA.fetchSyncStatus();
    const baseSeq = Number(status.head_sequence);
    const m2 = generateClientNodeId();
    await transportA.pushSyncMutations([
      {
        client_id: m2,
        op: "message_update",
        context_id: contextId,
        payload: {
          messages: [{ id: m1, role: "user", content: { message: "changed" }, metadata: { ic_client_node_id: m1 } }],
        },
      },
    ]);
    const delClient = generateClientNodeId();
    const stale = await transportB.pushSyncMutations([
      {
        client_id: delClient,
        op: "message_delete",
        context_id: contextId,
        base_sequence: baseSeq,
        payload: { ids: [m1] },
      },
    ]);
    assert.ok(stale.conflicts.some((c) => c.kind === "delete_stale_base" && c.client_id === delClient));
  });
});
