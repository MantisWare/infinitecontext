import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import {
  createInMemoryObjectStoreLocalState,
  ObjectStoreLogForkError,
  ObjectStoreLogRollbackError,
} from "../../lib/object-store-local-sync-state.mjs";
import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  deriveDevH,
  encryptLogSegment,
  layoutSegmentEnvelopeDigest,
  logSegmentRelativePath,
} from "../../lib/storage/layout.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import { decryptVaultStorageObjectPlaintext } from "../../lib/storage/storage-object-move.mjs";

const TEST_DEK = new Uint8Array(32).fill(21);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT = "accounts/trust-poc";

function transport(adapter, deviceUuid, localState) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT,
    localState,
  });
}

async function putRawSegment(adapter, layoutPrefix, devH, seq, record) {
  const envelope = encryptLogSegment(TEST_DEK, devH, record);
  const key = logSegmentRelativePath(layoutPrefix, devH, seq);
  const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
    ic_layout_segment_envelope_v1: envelope,
  });
  await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
  return { envelope, digest: layoutSegmentEnvelopeDigest(envelope) };
}

describe("object store trusted head PoC", () => {
  it("detects tail truncation after TOFU", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = transport(adapter, DEVICE_A, createInMemoryObjectStoreLocalState());
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { one: 1 } } },
    ]);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { two: 2 } } },
    ]);

    const bLocal = createInMemoryObjectStoreLocalState();
    const b = transport(adapter, DEVICE_B, bLocal);
    await b.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 10 });

    const listed = await adapter.list(`${LAYOUT}/ic-v1/log/`, { limit: 100 });
    const lastKey = listed.objects.map((o) => o.key).sort().at(-1);
    assert.ok(lastKey);
    await adapter.delete(lastKey);

    await assert.rejects(
      () => b.pullSyncChanges({ since: bLocal.load().vectorCursor, limit: 10 }),
      (err) => err instanceof ObjectStoreLogRollbackError,
    );
  });

  it("detects s1 rewrite when another device already saw s2", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = transport(adapter, DEVICE_A, createInMemoryObjectStoreLocalState());
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { s0: true } } },
    ]);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { s1: true } } },
    ]);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { s2: true } } },
    ]);

    const witness = transport(adapter, DEVICE_B, createInMemoryObjectStoreLocalState());
    const page = await witness.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 10 });
    assert.equal(page.changes.length, 3);

    const devH = deriveDevH(TEST_DEK, DEVICE_A);
    const key0 = logSegmentRelativePath(LAYOUT, devH, 0);
    const row0 = await adapter.get(key0);
    assert.ok(row0?.body);
    const plain0 = decryptVaultStorageObjectPlaintext(TEST_DEK, key0, row0.body);
    const inner0 = plain0.ic_layout_segment_envelope_v1;
    const digest0 = layoutSegmentEnvelopeDigest(inner0);
    await adapter.delete(logSegmentRelativePath(LAYOUT, devH, 1));
    await putRawSegment(adapter, LAYOUT, devH, 1, {
      dev: DEVICE_A,
      seq: 1,
      prev_digest: digest0,
      created_at: new Date().toISOString(),
      mutations: [
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { rewritten: 1 } },
          hlc: { wall_ms: 99, counter: 0, devH },
        },
      ],
    });

    await assert.rejects(
      () => witness.pullSyncChanges({ since: page.next_since, limit: 10 }),
      (err) => err instanceof ObjectStoreLogForkError,
    );
  });

  it("rejects forged own-prefix segment on push reconcile", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const local = createInMemoryObjectStoreLocalState();
    const a = transport(adapter, DEVICE_A, local);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { ok: 1 } } },
    ]);

    const devH = deriveDevH(TEST_DEK, DEVICE_A);
    const trusted = local.load().trustedHeads[devH];
    assert.ok(trusted);
    await putRawSegment(adapter, LAYOUT, devH, 1, {
      dev: DEVICE_A,
      seq: 1,
      prev_digest: "deadbeef".repeat(8),
      created_at: new Date().toISOString(),
      mutations: [
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { bad: true } },
          hlc: { wall_ms: 2, counter: 0, devH },
        },
      ],
    });

    await assert.rejects(
      () =>
        a.pushSyncMutations([
          {
            client_id: generateClientNodeId(),
            op: "context_create",
            payload: { metadata: { next: true } },
          },
        ]),
      (err) => err instanceof ObjectStoreLogForkError,
    );
  });

  it("persists TOFU trust across CLI restart and detects truncation", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-state-")), "sync-cli-state.json");
    const local = createCliFileObjectStoreLocalState(stateFile);
    const a = transport(adapter, DEVICE_A, local);
    await a.pushSyncMutations([
      { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { persist: 1 } } },
    ]);

    const restarted = transport(adapter, DEVICE_A, createCliFileObjectStoreLocalState(stateFile));
    const listed = await adapter.list(`${LAYOUT}/ic-v1/log/`, { limit: 20 });
    assert.ok(listed.objects.length > 0);
    for (const row of listed.objects) {
      await adapter.delete(row.key);
    }

    await assert.rejects(
      () => restarted.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 5 }),
      (err) => err instanceof ObjectStoreLogRollbackError || err.name === "ObjectStoreLogRollbackError",
    );
  });
});
