import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import {
  createInMemoryObjectStoreLocalState,
  ObjectStoreLogForkError,
  ObjectStoreLogMissingError,
  ObjectStoreLogRollbackError,
} from "../../lib/object-store-local-sync-state.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  deriveDevH,
  encryptLogSegment,
  logSegmentRelativePath,
} from "../../lib/storage/layout.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";

const TEST_DEK = new Uint8Array(32).fill(41);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LAYOUT = "accounts/owner-push";

function transport(adapter, localState) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid: DEVICE_A,
    layoutPrefix: LAYOUT,
    localState,
  });
}

describe("owner-side trusted anchor on push", () => {
  it("rejects push after trusted tip segment was deleted", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const local = createInMemoryObjectStoreLocalState();
    const a = transport(adapter, local);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { n: 1 } } },
    ]);
    const devH = deriveDevH(TEST_DEK, DEVICE_A);
    const tipKey = logSegmentRelativePath(LAYOUT, devH, 0);
    await adapter.delete(tipKey);
    await assert.rejects(
      () =>
        a.pushSyncMutations([
          { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { n: 2 } } },
        ]),
      (err) => err instanceof ObjectStoreLogRollbackError || err instanceof ObjectStoreLogMissingError,
    );
  });

  it("rejects push after forged segment appears on own prefix", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const local = createInMemoryObjectStoreLocalState();
    const a = transport(adapter, local);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { ok: true } } },
    ]);
    const devH = deriveDevH(TEST_DEK, DEVICE_A);
    const record = {
      dev: DEVICE_A,
      seq: 1,
      prev_digest: "deadbeef".repeat(8),
      created_at: new Date().toISOString(),
      mutations: [
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { forged: true } },
          hlc: { wall_ms: 1, counter: 0, devH },
        },
      ],
    };
    const envelope = encryptLogSegment(TEST_DEK, devH, record);
    const key = logSegmentRelativePath(LAYOUT, devH, 1);
    const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
      ic_layout_segment_envelope_v1: envelope,
    });
    await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
    await assert.rejects(
      () =>
        a.pushSyncMutations([
          { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { next: true } } },
        ]),
      (err) => err instanceof ObjectStoreLogForkError,
    );
  });
});
