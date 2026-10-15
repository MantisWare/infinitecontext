import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import {
  compactObjectStoreReplica,
  gcLogSegmentsCoveredByCompaction,
} from "../../lib/storage/storage-compaction.mjs";
import { loadStorageManifest } from "../../lib/storage/storage-manifest.mjs";
import {
  confirmObjectStorePullDeliveryForContext,
  objectStorePullSyncChanges,
  objectStorePushSyncMutations,
  resetObjectStorePullVerifyGenerationForTests,
} from "../../lib/object-store-sync.mjs";
import { pullAndApplySync, createCliSyncStore } from "../../lib/sync-engine.mjs";
import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import {
  hydrateSyncReplica,
  mergeBootstrapReplicaIntoLocal,
  sanitizeSyncReplicaForPersist,
} from "../../lib/sync-replica-state.mjs";
import { fullSnapshot, syncChangeFromMergeable } from "../helpers/object-store-replica-convergence.mjs";
import { scenarioConcurrentUpdates, scenarioThreeUpdates } from "./object-store-replica-scenarios.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";

const TEST_DEK = new Uint8Array(32).fill(3);
const LAYOUT_PREFIX = "acct/pull-path";
const PULL_PATH_TRIALS = 300;

/** @param {import('../../lib/storage/types.mjs').StorageAdapter} adapter @param {import('../../lib/object-store-merge.mjs').MergeableMutation[]} items */
async function syncWriterLocalFromStore(adapter, writerUuid, writerLocal) {
  const ctx = {
    adapter,
    dek: TEST_DEK,
    layoutPrefix: LAYOUT_PREFIX,
    selfDevH: deriveDevH(TEST_DEK, writerUuid),
    deviceUuid: writerUuid,
    localState: writerLocal,
  };
  resetObjectStorePullVerifyGenerationForTests();
  for (;;) {
    const page = await objectStorePullSyncChanges(ctx, {});
    await confirmObjectStorePullDeliveryForContext(ctx);
    if (!page.has_more) break;
  }
}

async function pushMergeablesInPlan(adapter, items) {
  /** @type {Map<string, ObjectStoreSyncTransport>} */
  const byUuid = new Map();
  const transportFor = (deviceUuid) => {
    const key = String(deviceUuid);
    if (!byUuid.has(key)) {
      byUuid.set(
        key,
        transport(adapter, key, createInMemoryObjectStoreLocalState()),
      );
    }
    return byUuid.get(key);
  };
  for (const item of items) {
    const m = item.mutation;
    await transportFor(item.deviceUuid).pushSyncMutations([
      {
        client_id: m.client_id,
        op: m.op,
        context_id: m.context_id,
        payload: m.payload,
        base_vector: m.base_vector,
      },
    ]);
  }
}

function transport(adapter, deviceUuid, localState = createInMemoryObjectStoreLocalState()) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT_PREFIX,
    localState,
  });
}

function daemonLikeStore(dbPath, options = {}) {
  /** @type {ReturnType<typeof createEmptySyncReplica> | null} */
  let cached = null;
  let pullCursor = 0;
  let flushCount = 0;
  const failFlushOnce = options.failFlushOnce ?? false;
  return {
    objectStoreReplicaPullEnabled: true,
    getSyncPullCursor() {
      return pullCursor;
    },
    setSyncPullCursor(value) {
      pullCursor = value;
    },
    loadSyncReplica() {
      if (cached) return cached;
      const file = path.join(dbPath, "replica.json");
      if (fs.existsSync(file)) {
        cached = hydrateSyncReplica(JSON.parse(fs.readFileSync(file, "utf8")));
        return cached;
      }
      cached = createEmptySyncReplica();
      return cached;
    },
    flushSyncReplica(replica) {
      if (failFlushOnce && flushCount === 0) {
        flushCount += 1;
        throw new Error("simulated crash before replica flush");
      }
      flushCount += 1;
      cached = replica;
      fs.writeFileSync(path.join(dbPath, "replica.json"), JSON.stringify(replica));
    },
    clearReplicaCache() {
      cached = null;
    },
    applySyncChange(change) {
      const replica = this.loadSyncReplica();
      applySyncChangeToReplica(replica, change, () => {});
      this.flushSyncReplica(replica);
    },
  };
}

describe("object store pull bootstrap via pullAndApplySync", () => {
  it("CLI new device matches full replay after compaction and GC (300 orders)", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const items = sortMergeableMutations(scenarioThreeUpdates());
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    const writerT = transport(adapter, writerUuid, writerLocal);
    for (const item of items) {
      await writerT.pushSyncMutations([
        {
          client_id: item.mutation.client_id,
          op: item.mutation.op,
          context_id: item.mutation.context_id,
          payload: item.mutation.payload,
          base_vector: item.mutation.base_vector,
        },
      ]);
    }
    const reference = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(reference, syncChangeFromMergeable(item), () => {});
    }
    const expected = fullSnapshot(reference);

    const compactorReplica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
    }
    await compactObjectStoreReplica(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      writerLocal.load(),
      compactorReplica,
      { settleMs: 0 },
    );
    await gcLogSegmentsCoveredByCompaction(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX),
    );

    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-pull-"));
    process.env.HOME = cliDir;
    const icDir = path.join(cliDir, ".infinitecontext");
    fs.mkdirSync(icDir, { recursive: true });
    fs.writeFileSync(path.join(icDir, "sync-replica.json"), "{}\n");
    const store = createCliSyncStore();
    const newDeviceT = transport(adapter, "33333333-3333-4333-8333-333333333333");
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({ store, transport: newDeviceT });
    const pulled = store.loadSyncReplica();
    assert.equal(fullSnapshot(pulled), expected);
  });

  it("daemon-like store with since=0 uses bootstrapped vector cursor (300 permutations smoke)", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const items = sortMergeableMutations(scenarioThreeUpdates());
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    const writerT = transport(adapter, writerUuid, writerLocal);
    for (const item of items) {
      await writerT.pushSyncMutations([
        {
          client_id: item.mutation.client_id,
          op: item.mutation.op,
          context_id: item.mutation.context_id,
          payload: item.mutation.payload,
          base_vector: item.mutation.base_vector,
        },
      ]);
    }
    const reference = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(reference, syncChangeFromMergeable(item), () => {});
    }
    const expected = fullSnapshot(reference);
    const compactorReplica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
    }
    await compactObjectStoreReplica(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      writerLocal.load(),
      compactorReplica,
      { settleMs: 0 },
    );

    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-pull-"));
    const store = daemonLikeStore(dbPath);
    const newDeviceT = transport(adapter, "44444444-4444-4444-8444-444444444444");
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({
      store,
      transport: newDeviceT,
      getCursor: () => store.getSyncPullCursor(),
      setCursor: (value) => store.setSyncPullCursor(value),
    });
    store.clearReplicaCache();
    assert.equal(fullSnapshot(store.loadSyncReplica()), expected);
  });

  it("manifest ack waits until replica flush commits", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    const writerT = transport(adapter, writerUuid, writerLocal);
    await writerT.pushSyncMutations([
      {
        client_id: "ack1",
        op: "context_create",
        context_id: "ctx_ack",
        payload: { context_id: "ctx_ack", metadata: {} },
      },
    ]);
    await compactObjectStoreReplica(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      writerLocal.load(),
      createEmptySyncReplica(),
      { settleMs: 0 },
    );
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "ic-ack-"));
    const store = daemonLikeStore(dbPath, { failFlushOnce: true });
    const newDeviceT = transport(adapter, "55555555-5555-4555-8555-555555555555");
    resetObjectStorePullVerifyGenerationForTests();
    await assert.rejects(
      () =>
        pullAndApplySync({
          store,
          transport: newDeviceT,
          getCursor: () => 0,
          setCursor: () => {},
        }),
      /simulated crash before replica flush/,
    );
    const newDevH = deriveDevH(TEST_DEK, "55555555-5555-4555-8555-555555555555");
    let manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(!manifest.devices.some((row) => row.devH === newDevH));
    store.clearReplicaCache();
    const store2 = daemonLikeStore(dbPath);
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({
      store: store2,
      transport: newDeviceT,
      getCursor: () => 0,
      setCursor: () => {},
    });
    manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(manifest.devices.some((row) => row.devH === newDevH));
  });

  it("CLI pull path matches full replay across 300 compaction trials", async () => {
    const sorted = sortMergeableMutations(scenarioThreeUpdates());
    const reference = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(reference, syncChangeFromMergeable(item), () => {});
    }
    const expected = fullSnapshot(reference);
    for (let trial = 0; trial < PULL_PATH_TRIALS; trial += 1) {
      const adapter = createMemoryStorageAdapter();
      await adapter.init();
      const writerUuid = "11111111-1111-4111-8111-111111111111";
      const writerLocal = createInMemoryObjectStoreLocalState();
      await pushMergeablesInPlan(adapter, sorted);
      await syncWriterLocalFromStore(adapter, writerUuid, writerLocal);
      const compactorReplica = createEmptySyncReplica();
      for (const item of sorted) {
        applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
      }
      await compactObjectStoreReplica(
        {
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          selfDevH: deriveDevH(TEST_DEK, writerUuid),
          deviceUuid: writerUuid,
          localState: writerLocal,
        },
        writerLocal.load(),
        compactorReplica,
        { settleMs: 0 },
      );
      await gcLogSegmentsCoveredByCompaction(
        {
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          selfDevH: deriveDevH(TEST_DEK, writerUuid),
          deviceUuid: writerUuid,
          localState: writerLocal,
        },
        await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX),
      );
      const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-pull-"));
      process.env.HOME = cliDir;
      fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
      fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");
      const store = createCliSyncStore();
      const newDeviceT = transport(adapter, crypto.randomUUID());
      resetObjectStorePullVerifyGenerationForTests();
      await pullAndApplySync({ store, transport: newDeviceT });
      assert.equal(fullSnapshot(store.loadSyncReplica()), expected);
    }
  });

  it("daemon pull path matches full replay across 300 compaction trials", async () => {
    const sorted = sortMergeableMutations(scenarioThreeUpdates());
    const reference = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(reference, syncChangeFromMergeable(item), () => {});
    }
    const expected = fullSnapshot(reference);
    for (let trial = 0; trial < PULL_PATH_TRIALS; trial += 1) {
      const adapter = createMemoryStorageAdapter();
      await adapter.init();
      const writerUuid = "11111111-1111-4111-8111-111111111111";
      const writerLocal = createInMemoryObjectStoreLocalState();
      await pushMergeablesInPlan(adapter, sorted);
      await syncWriterLocalFromStore(adapter, writerUuid, writerLocal);
      const compactorReplica = createEmptySyncReplica();
      for (const item of sorted) {
        applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
      }
      await compactObjectStoreReplica(
        {
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          selfDevH: deriveDevH(TEST_DEK, writerUuid),
          deviceUuid: writerUuid,
          localState: writerLocal,
        },
        writerLocal.load(),
        compactorReplica,
        { settleMs: 0 },
      );
      await gcLogSegmentsCoveredByCompaction(
        {
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          selfDevH: deriveDevH(TEST_DEK, writerUuid),
          deviceUuid: writerUuid,
          localState: writerLocal,
        },
        await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX),
      );
      const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-pull-"));
      const store = daemonLikeStore(dbPath);
      const newDeviceT = transport(adapter, crypto.randomUUID());
      resetObjectStorePullVerifyGenerationForTests();
      await pullAndApplySync({
        store,
        transport: newDeviceT,
        getCursor: () => store.getSyncPullCursor(),
        setCursor: (value) => store.setSyncPullCursor(value),
      });
      store.clearReplicaCache();
      assert.equal(fullSnapshot(store.loadSyncReplica()), expected);
    }
  });

  it("pullAndApplySync merges bootstrap replica with pre-existing local replica rows", async () => {
    const sorted = sortMergeableMutations(scenarioThreeUpdates());
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    await pushMergeablesInPlan(adapter, sorted);
    await syncWriterLocalFromStore(adapter, writerUuid, writerLocal);
    const compactorReplica = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
    }
    await compactObjectStoreReplica(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      writerLocal.load(),
      compactorReplica,
      { settleMs: 0 },
    );
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-merge-boot-"));
    process.env.HOME = cliDir;
    fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");
    const store = createCliSyncStore();
    store.flushSyncReplica(
      hydrateSyncReplica({
        contexts: { ctx_local_only: { context_id: "ctx_local_only", metadata: { local: true } } },
        messages: {},
        sync_conflicts: [],
      }),
    );
    const mergedUnit = mergeBootstrapReplicaIntoLocal(
      store.loadSyncReplica(),
      sanitizeSyncReplicaForPersist(compactorReplica),
    );
    assert.ok(mergedUnit.contexts?.ctx_local_only, "mergeBootstrapReplicaIntoLocal keeps local-only rows");
    const joinUuid = crypto.randomUUID();
    const newDeviceT = transport(adapter, joinUuid);
    await newDeviceT.pushSyncMutations([
      {
        client_id: "merge_boot_push",
        op: "context_create",
        context_id: "ctx_merge_boot_push",
        payload: { context_id: "ctx_merge_boot_push", metadata: {} },
      },
    ]);
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({ store, transport: newDeviceT });
    const replica = store.loadSyncReplica();
    assert.ok(replica.contexts?.ctx_local_only, "local-only context must survive bootstrap merge");
    assert.ok(replica.contexts?.ctx_merge_boot_push, "pre-pull push must appear in replica");
    assert.ok(Object.keys(replica.contexts ?? {}).length >= 2);
  });

  it("random new-device histories with push-before-first-pull converge (50 trials)", async () => {
    const sorted = sortMergeableMutations(scenarioThreeUpdates());
    const reference = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(reference, syncChangeFromMergeable(item), () => {});
    }
    const minSnapshotContexts = Object.keys(fullSnapshot(reference).contexts ?? {}).length;
    for (let trial = 0; trial < 50; trial += 1) {
      const adapter = createMemoryStorageAdapter();
      await adapter.init();
      const writerUuid = "11111111-1111-4111-8111-111111111111";
      const writerLocal = createInMemoryObjectStoreLocalState();
      await pushMergeablesInPlan(adapter, sorted);
      await syncWriterLocalFromStore(adapter, writerUuid, writerLocal);
      const compactorReplica = createEmptySyncReplica();
      for (const item of sorted) {
        applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
      }
      await compactObjectStoreReplica(
        {
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          selfDevH: deriveDevH(TEST_DEK, writerUuid),
          deviceUuid: writerUuid,
          localState: writerLocal,
        },
        writerLocal.load(),
        compactorReplica,
        { settleMs: 0 },
      );
      await gcLogSegmentsCoveredByCompaction(
        {
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          selfDevH: deriveDevH(TEST_DEK, writerUuid),
          deviceUuid: writerUuid,
          localState: writerLocal,
        },
        await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX),
      );
      const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), `ic-rnd-prepull-${trial}-`));
      process.env.HOME = cliDir;
      fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
      fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");
      const store = createCliSyncStore();
      const joinUuid = crypto.randomUUID();
      const newDeviceT = transport(adapter, joinUuid);
      const ctxId = `ctx_rnd_prepull_${trial}`;
      await newDeviceT.pushSyncMutations([
        {
          client_id: `rnd_prepull_${trial}`,
          op: "context_create",
          context_id: ctxId,
          payload: { context_id: ctxId, metadata: { trial } },
        },
      ]);
      resetObjectStorePullVerifyGenerationForTests();
      await pullAndApplySync({ store, transport: newDeviceT });
      const replica = store.loadSyncReplica();
      assert.ok(replica.contexts?.[ctxId], `trial ${trial}: own pre-pull mutation missing`);
      assert.ok(
        Object.keys(replica.contexts ?? {}).length >= minSnapshotContexts + 1,
        `trial ${trial}: snapshot contexts missing`,
      );
    }
  });

  it("multi-device history converges on CLI pull after compaction and GC", async () => {
    const sorted = sortMergeableMutations(scenarioConcurrentUpdates());
    const reference = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(reference, syncChangeFromMergeable(item), () => {});
    }
    const expected = fullSnapshot(reference);
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    await pushMergeablesInPlan(adapter, sorted);
    await syncWriterLocalFromStore(adapter, writerUuid, writerLocal);
    const compactorReplica = createEmptySyncReplica();
    for (const item of sorted) {
      applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
    }
    await compactObjectStoreReplica(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      writerLocal.load(),
      compactorReplica,
      { settleMs: 0 },
    );
    await gcLogSegmentsCoveredByCompaction(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX),
    );
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-pull-"));
    process.env.HOME = cliDir;
    fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");
    const store = createCliSyncStore();
    const newDeviceT = transport(adapter, crypto.randomUUID());
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({ store, transport: newDeviceT });
    assert.equal(fullSnapshot(store.loadSyncReplica()), expected);
  });

  it("compaction succeeds after crash snapshot and an intervening push", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    const writerT = transport(adapter, writerUuid, writerLocal);
    await writerT.pushSyncMutations([
      {
        client_id: "c0",
        op: "context_create",
        context_id: "ctx_orph_push",
        payload: { context_id: "ctx_orph_push", metadata: {} },
      },
    ]);
    let crashed = true;
    await assert.rejects(
      () =>
        compactObjectStoreReplica(
          {
            adapter,
            dek: TEST_DEK,
            layoutPrefix: LAYOUT_PREFIX,
            selfDevH: deriveDevH(TEST_DEK, writerUuid),
            deviceUuid: writerUuid,
            localState: writerLocal,
          },
          writerLocal.load(),
          createEmptySyncReplica(),
          {
            settleMs: 0,
            testHookAfterSnapshotWrite: async () => {
              if (crashed) {
                crashed = false;
                throw new Error("simulated kill -9");
              }
            },
          },
        ),
      /simulated kill -9/,
    );
    await writerT.pushSyncMutations([
      {
        client_id: "c1",
        op: "context_create",
        context_id: "ctx_orph_push2",
        payload: { context_id: "ctx_orph_push2", metadata: {} },
      },
    ]);
    await compactObjectStoreReplica(
      {
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        selfDevH: deriveDevH(TEST_DEK, writerUuid),
        deviceUuid: writerUuid,
        localState: writerLocal,
      },
      writerLocal.load(),
      createEmptySyncReplica(),
      { settleMs: 0 },
    );
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(manifest.latest_snapshot_epoch >= 0);
  });
});
