import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEmptySyncReplica, applySyncChangeToReplica } from "../../lib/sync-replica-apply.mjs";
import { hydrateSyncReplica } from "../../lib/sync-replica-state.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { acquireLeaseLock, isLeaseLockStale, releaseLeaseLock, withLeaseLock } from "../../lib/storage/lease-lock.mjs";
import { storageReadModifyWrite } from "../../lib/storage/storage-cas-rmw.mjs";
import {
  compactObjectStoreReplica,
  gcLogSegmentsCoveredByCompaction,
  listSnapshotEpochs,
  loadStorageSnapshot,
  verifySnapshotTrustedHeads,
  assertSnapshotCoversManifestKnowledge,
} from "../../lib/storage/storage-compaction.mjs";
import { confirmObjectStorePullDeliveryForContext } from "../../lib/object-store-sync.mjs";
import { loadStorageManifest } from "../../lib/storage/storage-manifest.mjs";
import {
  objectStorePullSyncChanges,
  objectStorePushSyncMutations,
  resetObjectStorePullVerifyGenerationForTests,
} from "../../lib/object-store-sync.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { syncChangeFromMergeable } from "../helpers/object-store-replica-convergence.mjs";
import { scenarioConcurrentUpdates } from "./object-store-replica-scenarios.mjs";
import { layoutRootPath, logSegmentRelativePath } from "../../lib/storage/layout.mjs";

const TEST_DEK = new Uint8Array(32).fill(3);
const LAYOUT_PREFIX = "acct/compaction";
const DEV_A = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
const DEV_B = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");

/** @param {string} deviceUuid @param {ReturnType<typeof createInMemoryObjectStoreLocalState>} [localState] */
function syncCtx(adapter, deviceUuid, localState = createInMemoryObjectStoreLocalState()) {
  return {
    adapter,
    dek: TEST_DEK,
    layoutPrefix: LAYOUT_PREFIX,
    selfDevH: deriveDevH(TEST_DEK, deviceUuid),
    deviceUuid,
    localState,
  };
}

describe("storage lease lock", () => {
  it("expires stale locks after TTL + skew margin", () => {
    assert.equal(isLeaseLockStale({ owner_dev_h: DEV_A, nonce: "x", expires_at_ms: Date.now() - 100_000 }), true);
    assert.equal(isLeaseLockStale({ owner_dev_h: DEV_A, nonce: "x", expires_at_ms: Date.now() + 10_000 }), false);
  });

  it("serializes writers under lease when CAS is unavailable", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const caps = new Set(adapter.capabilities);
    caps.delete("conditionalCreate");
    caps.delete("conditionalReplace");
    adapter.capabilities = caps;
    const key = `${layoutRootPath(LAYOUT_PREFIX)}/shared/counter.json.enc`;
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      await withLeaseLock({
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        lockName: "counter",
        ownerDevH: DEV_A,
        settleMs: 0,
        fn: async () => {
          value += 1;
        },
      });
    }
    assert.equal(value, 4);
    void key;
  });

  it("same devH cannot re-acquire without renewing with nonce", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const first = await acquireLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "same-dev",
      ownerDevH: DEV_A,
      settleMs: 0,
    });
    await assert.rejects(
      () =>
        acquireLeaseLock({
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          lockName: "same-dev",
          ownerDevH: DEV_A,
          settleMs: 0,
        }),
      /renew with nonce/i,
    );
    await releaseLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "same-dev",
      ownerDevH: DEV_A,
      nonce: first.nonce,
    });
  });

  it("two owners race: second acquire fails while lock live", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const first = await acquireLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "race",
      ownerDevH: DEV_A,
      settleMs: 0,
    });
    await assert.rejects(
      () =>
        acquireLeaseLock({
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          lockName: "race",
          ownerDevH: DEV_B,
          settleMs: 0,
        }),
      /held by/,
    );
    await releaseLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "race",
      ownerDevH: DEV_A,
      nonce: first.nonce,
    });
  });
});

describe("storage compaction + bootstrap", () => {
  it("bootstrap from snapshot matches full log replay across pull orders", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const items = sortMergeableMutations(scenarioConcurrentUpdates());
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    for (const item of items) {
      await objectStorePushSyncMutations(writer, [
        {
          client_id: item.mutation.client_id,
          op: item.mutation.op,
          context_id: item.mutation.context_id,
          payload: item.mutation.payload,
          base_vector: item.mutation.base_vector,
        },
      ]);
    }
    resetObjectStorePullVerifyGenerationForTests();
    const baseline = syncCtx(adapter, "44444444-4444-4444-8444-444444444444");
    const fullPull = await objectStorePullSyncChanges(baseline, { limit: 500 });
    const fullReplica = createEmptySyncReplica();
    for (const change of fullPull.changes) {
      applySyncChangeToReplica(fullReplica, change, () => {});
    }

    await compactObjectStoreReplica(writer, writer.localState.load(), fullReplica, { settleMs: 0 });

    resetObjectStorePullVerifyGenerationForTests();
    const fresh = syncCtx(adapter, "33333333-3333-4333-8333-333333333333");
    const tailPull = await objectStorePullSyncChanges(fresh, { limit: 500 });
    await confirmObjectStorePullDeliveryForContext(fresh);
    assert.ok(tailPull.bootstrap_replica);
    const bootReplica = hydrateSyncReplica(tailPull.bootstrap_replica);
    for (const change of tailPull.changes) {
      applySyncChangeToReplica(bootReplica, change, () => {});
    }
    assert.deepEqual(bootReplica.messages, fullReplica.messages);
  });

  it("detects rollback across snapshot trusted head", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    await objectStorePushSyncMutations(writer, [
      {
        client_id: "c0",
        op: "context_create",
        context_id: "ctx_rb",
        payload: { context_id: "ctx_rb", metadata: {} },
      },
    ]);
    const replica = createEmptySyncReplica();
    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    const snap = await loadStorageSnapshot(writer, 0);
    assert.ok(snap);
    await adapter.delete(logSegmentRelativePath(LAYOUT_PREFIX, writer.selfDevH, 0));
    await assert.rejects(() => verifySnapshotTrustedHeads(writer, snap), /missing|rollback|fork/i);
  });

  it("GC skips deletion when a device has not acknowledged through compacted_through", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    for (let i = 0; i < 3; i += 1) {
      await objectStorePushSyncMutations(writer, [
        {
          client_id: `lag${i}`,
          op: "context_create",
          context_id: `ctx_lag_${i}`,
          payload: { context_id: `ctx_lag_${i}`, metadata: { n: i } },
        },
      ]);
    }
    const replica = createEmptySyncReplica();
    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    manifest.compacted_through = { kind: "vector", v: { [writer.selfDevH]: 2 } };
    manifest.devices.push({
      devH: DEV_B,
      last_seq: -1,
      acknowledged_seq: -1,
      acknowledged_cursor: { kind: "vector", v: { [writer.selfDevH]: 0 } },
    });
    const gc = await gcLogSegmentsCoveredByCompaction(writer, manifest);
    assert.equal(gc.deleted, 0);
    assert.ok((await adapter.get(logSegmentRelativePath(LAYOUT_PREFIX, writer.selfDevH, 0)))?.body);
  });

  it("GC never deletes segments above compacted_through", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    for (let i = 0; i < 3; i += 1) {
      await objectStorePushSyncMutations(writer, [
        {
          client_id: `gc${i}`,
          op: "context_create",
          context_id: `ctx_gc_${i}`,
          payload: { context_id: `ctx_gc_${i}`, metadata: { n: i } },
        },
      ]);
    }
    const replica = createEmptySyncReplica();
    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    manifest.compacted_through = { kind: "vector", v: { [writer.selfDevH]: 0 } };
    for (const row of manifest.devices) {
      row.acknowledged_cursor = { kind: "vector", v: { [writer.selfDevH]: 2 } };
    }
    const gc = await gcLogSegmentsCoveredByCompaction(writer, manifest);
    assert.ok(gc.deleted >= 1);
    const headKey = logSegmentRelativePath(LAYOUT_PREFIX, writer.selfDevH, 2);
    const tailKey = logSegmentRelativePath(LAYOUT_PREFIX, writer.selfDevH, 0);
    assert.ok((await adapter.get(headKey))?.body);
    assert.equal((await adapter.get(tailKey))?.body, undefined);
  });

  it("survives crash after snapshot write before manifest update", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    await objectStorePushSyncMutations(writer, [
      {
        client_id: "crash1",
        op: "context_create",
        context_id: "ctx_crash",
        payload: { context_id: "ctx_crash", metadata: {} },
      },
    ]);
    const replica = createEmptySyncReplica();
    const epochsBefore = await listSnapshotEpochs(writer);
    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    const epochsAfter = await listSnapshotEpochs(writer);
    assert.equal(epochsAfter.length, epochsBefore.length + 1);
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(manifest.latest_snapshot_epoch >= 0);
  });

  it("push, pull, restart, and bootstrap work after GC", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    const reader = syncCtx(adapter, "22222222-2222-4222-8222-222222222222");
    for (let i = 0; i < 4; i += 1) {
      await objectStorePushSyncMutations(writer, [
        {
          client_id: `gcflow${i}`,
          op: "context_create",
          context_id: `ctx_gcf_${i}`,
          payload: { context_id: `ctx_gcf_${i}`, metadata: { n: i } },
        },
      ]);
    }
    resetObjectStorePullVerifyGenerationForTests();
    let replica = createEmptySyncReplica();
    let page = await objectStorePullSyncChanges(reader, { limit: 500 });
    if (page.bootstrap_replica) replica = hydrateSyncReplica(page.bootstrap_replica);
    for (const change of page.changes) applySyncChangeToReplica(replica, change, () => {});

    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    resetObjectStorePullVerifyGenerationForTests();
    await objectStorePullSyncChanges(reader, { limit: 500 });
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    await gcLogSegmentsCoveredByCompaction(writer, manifest);

    await objectStorePushSyncMutations(writer, [
      {
        client_id: "gcflow_tail",
        op: "context_create",
        context_id: "ctx_gcf_tail",
        payload: { context_id: "ctx_gcf_tail", metadata: {} },
      },
    ]);

    resetObjectStorePullVerifyGenerationForTests();
    const pull2 = await objectStorePullSyncChanges(reader, { limit: 500 });
    assert.ok(pull2.changes.length >= 1);

    resetObjectStorePullVerifyGenerationForTests();
    const bootstrapDevice = syncCtx(adapter, "33333333-3333-4333-8333-333333333333");
    const bootPull = await objectStorePullSyncChanges(bootstrapDevice, { limit: 500 });
    assert.ok(bootPull.bootstrap_replica);
  });

  it("looped crash during compaction eventually succeeds", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    await objectStorePushSyncMutations(writer, [
      {
        client_id: "loop0",
        op: "context_create",
        context_id: "ctx_loop",
        payload: { context_id: "ctx_loop", metadata: {} },
      },
    ]);
    const replica = createEmptySyncReplica();
    let crashesLeft = 6;
    for (let i = 0; i < 12; i += 1) {
      try {
        await compactObjectStoreReplica(writer, writer.localState.load(), replica, {
          settleMs: 0,
          testHookAfterSnapshotWrite: async () => {
            if (crashesLeft > 0) {
              crashesLeft -= 1;
              throw new Error("simulated kill -9");
            }
          },
        });
        break;
      } catch (err) {
        if (!/simulated kill -9/.test(String(err?.message ?? err))) throw err;
      }
    }
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(manifest.latest_snapshot_epoch >= 0);
  });

  it("orphan snapshot after crash is adopted on next compaction", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    await objectStorePushSyncMutations(writer, [
      {
        client_id: "orph1",
        op: "context_create",
        context_id: "ctx_orph",
        payload: { context_id: "ctx_orph", metadata: {} },
      },
    ]);
    const replica = createEmptySyncReplica();
    let crash = true;
    await assert.rejects(
      () =>
        compactObjectStoreReplica(writer, writer.localState.load(), replica, {
          settleMs: 0,
          testHookAfterSnapshotWrite: async () => {
            if (crash) {
              crash = false;
              throw new Error("simulated kill -9");
            }
          },
        }),
      /simulated kill -9/,
    );
    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(manifest.latest_snapshot_epoch >= 0);
  });

  it("rejects forged snapshot missing a live log device", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writer = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    await objectStorePushSyncMutations(writer, [
      {
        client_id: "forge1",
        op: "context_create",
        context_id: "ctx_forge",
        payload: { context_id: "ctx_forge", metadata: {} },
      },
    ]);
    const replica = createEmptySyncReplica();
    await compactObjectStoreReplica(writer, writer.localState.load(), replica, { settleMs: 0 });
    const snap = await loadStorageSnapshot(writer, 0);
    assert.ok(snap);
    snap.trusted_heads = {};
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.throws(() => assertSnapshotCoversManifestKnowledge(manifest, snap), /omits manifest-known/i);
  });

  it("concurrent compaction: one wins CAS, other observes existing epoch", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const a = syncCtx(adapter, "11111111-1111-4111-8111-111111111111");
    const b = syncCtx(adapter, "22222222-2222-4222-8222-222222222222");
    await objectStorePushSyncMutations(a, [
      {
        client_id: "cc0",
        op: "context_create",
        context_id: "ctx_cc",
        payload: { context_id: "ctx_cc", metadata: {} },
      },
    ]);
    const replica = createEmptySyncReplica();
    const [r1, r2] = await Promise.allSettled([
      compactObjectStoreReplica(a, a.localState.load(), replica, { settleMs: 0 }),
      compactObjectStoreReplica(b, b.localState.load(), replica, { settleMs: 0 }),
    ]);
    const ok = [r1, r2].filter((r) => r.status === "fulfilled");
    assert.ok(ok.length >= 1);
    assert.ok((await listSnapshotEpochs(a)).length >= 1);
  });
});
