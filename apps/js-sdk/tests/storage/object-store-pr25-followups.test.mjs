import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createCliFileObjectStoreLocalState,
  createDaemonDbObjectStoreLocalState,
  hydrateObjectStoreLocalSyncState,
  serializeObjectStoreLocalSyncState,
} from "../../lib/object-store-local-state-persist.mjs";
import {
  createEmptyObjectStoreLocalSyncState,
  createInMemoryObjectStoreLocalState,
} from "../../lib/object-store-local-sync-state.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import {
  compactObjectStoreReplica,
  gcLogSegmentsCoveredByCompaction,
  isCompactionCaughtUpWithManifest,
} from "../../lib/storage/storage-compaction.mjs";
import {
  loadStorageManifest,
  loadStorageManifestForSync,
  removeManifestDevice,
  updateStorageManifest,
} from "../../lib/storage/storage-manifest.mjs";
import {
  confirmObjectStorePullDeliveryForContext,
  objectStorePullSyncChanges,
  objectStorePushSyncMutations,
  resetObjectStorePullVerifyGenerationForTests,
} from "../../lib/object-store-sync.mjs";
import { pullAndApplySync, createCliSyncStore } from "../../lib/sync-engine.mjs";
import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { sanitizeSyncReplicaForPersist } from "../../lib/sync-replica-state.mjs";
import { fullSnapshot, syncChangeFromMergeable } from "../helpers/object-store-replica-convergence.mjs";
import { scenarioThreeUpdates } from "./object-store-replica-scenarios.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";

const TEST_DEK = new Uint8Array(32).fill(3);
const LAYOUT_PREFIX = "acct/pr25";

function ctx(adapter, uuid, localState) {
  return {
    adapter,
    dek: TEST_DEK,
    layoutPrefix: LAYOUT_PREFIX,
    selfDevH: deriveDevH(TEST_DEK, uuid),
    deviceUuid: uuid,
    localState,
  };
}

function transport(adapter, uuid, localState = createInMemoryObjectStoreLocalState()) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid: uuid,
    layoutPrefix: LAYOUT_PREFIX,
    localState,
  });
}

describe("PR #25 follow-ups", () => {
  it("persists bootstrap pending fields across file and daemon-db state", async () => {
    const pending = sanitizeSyncReplicaForPersist(createEmptySyncReplica());
    pending.messages = { m1: { payload: { body: "x" } } };
    const state = createEmptyObjectStoreLocalSyncState();
    state.pendingBootstrapReplica = pending;
    state.bootstrapReplicaPendingAck = true;
    state.appliedSnapshotEpoch = 2;
    state.snapshotCompactedThrough = { kind: "vector", v: { ABCD: 2 } };
    state.manifestGenerationHighWater = 7;
    const serialized = serializeObjectStoreLocalSyncState(state);
    const hydrated = hydrateObjectStoreLocalSyncState(serialized);
    assert.equal(hydrated.bootstrapReplicaPendingAck, true);
    assert.equal(hydrated.appliedSnapshotEpoch, 2);
    assert.equal(hydrated.manifestGenerationHighWater, 7);
    assert.ok(hydrated.pendingBootstrapReplica);

    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-state-")), "object-store-sync-state.json");
    const fileBackend = createCliFileObjectStoreLocalState(filePath);
    await fileBackend.save(state);
    const fromFile = fileBackend.load();
    assert.equal(fromFile.bootstrapReplicaPendingAck, true);
    assert.ok(fromFile.pendingBootstrapReplica);

    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-db-")), "daemon.db");
    const dbBackend = createDaemonDbObjectStoreLocalState(dbPath);
    await dbBackend.save(state);
    const fromDb = dbBackend.load();
    assert.equal(fromDb.bootstrapReplicaPendingAck, true);
    assert.ok(fromDb.pendingBootstrapReplica);
    dbBackend.close();
  });

  it("CLI redelivers pending bootstrap after crash before replica flush", async () => {
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
    const compactorReplica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(compactorReplica, syncChangeFromMergeable(item), () => {});
    }
    await compactObjectStoreReplica(
      ctx(adapter, writerUuid, writerLocal),
      writerLocal.load(),
      compactorReplica,
      { settleMs: 0 },
    );
    await gcLogSegmentsCoveredByCompaction(ctx(adapter, writerUuid, writerLocal));

    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-crash-cli-"));
    process.env.HOME = cliDir;
    fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");

    const fileStatePath = path.join(cliDir, ".infinitecontext", "object-store-sync-state.json");
    const fileState = createCliFileObjectStoreLocalState(fileStatePath);
    const newUuid = "33333333-3333-4333-8333-333333333333";
    const newLocal = fileState;
    const newT = transport(adapter, newUuid, newLocal);
    resetObjectStorePullVerifyGenerationForTests();
    const page = await objectStorePullSyncChanges(ctx(adapter, newUuid, newLocal), {});
    assert.ok(page.bootstrap_replica);
    const saved = newLocal.load();
    assert.ok(saved.pendingBootstrapReplica);
    assert.equal(saved.bootstrapReplicaPendingAck, true);
    const manifestBefore = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(!manifestBefore.devices.some((row) => row.devH === deriveDevH(TEST_DEK, newUuid)));

    resetObjectStorePullVerifyGenerationForTests();
    const page2 = await objectStorePullSyncChanges(ctx(adapter, newUuid, createCliFileObjectStoreLocalState(fileStatePath)), {});
    assert.ok(page2.bootstrap_replica);
    await confirmObjectStorePullDeliveryForContext(ctx(adapter, newUuid, createCliFileObjectStoreLocalState(fileStatePath)));
    const manifestAfter = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(manifestAfter.devices.some((row) => row.devH === deriveDevH(TEST_DEK, newUuid)));
  });

  it("daemon redelivers pending bootstrap from daemon.db after crash before flush", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    await objectStorePushSyncMutations(ctx(adapter, writerUuid, writerLocal), [
      {
        client_id: "c0",
        op: "context_create",
        context_id: "ctx_crash",
        payload: { context_id: "ctx_crash", metadata: {} },
      },
    ]);
    await compactObjectStoreReplica(
      ctx(adapter, writerUuid, writerLocal),
      writerLocal.load(),
      createEmptySyncReplica(),
      { settleMs: 0 },
    );

    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "ic-crash-daemon-"));
    const dbFile = path.join(dbPath, "daemon.db");
    const daemonState = createDaemonDbObjectStoreLocalState(dbFile);
    const newUuid = "44444444-4444-4444-8444-444444444444";
    resetObjectStorePullVerifyGenerationForTests();
    const page = await objectStorePullSyncChanges(ctx(adapter, newUuid, daemonState), {});
    assert.ok(page.bootstrap_replica);
    const mid = daemonState.load();
    assert.ok(mid.pendingBootstrapReplica);
    assert.equal(mid.bootstrapReplicaPendingAck, true);
    await daemonState.save(mid);

    const daemonState2 = createDaemonDbObjectStoreLocalState(dbFile);
    resetObjectStorePullVerifyGenerationForTests();
    const page2 = await objectStorePullSyncChanges(ctx(adapter, newUuid, daemonState2), {});
    assert.ok(page2.bootstrap_replica);
    assert.equal((page2.changes ?? []).length, 0);
    daemonState2.close();
    daemonState.close();
  });

  it("lagging compactor skips and new device still bootstraps", async () => {
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
    const replica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(replica, syncChangeFromMergeable(item), () => {});
    }
    await compactObjectStoreReplica(ctx(adapter, writerUuid, writerLocal), writerLocal.load(), replica, {
      settleMs: 0,
    });
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    const laggingLocal = createInMemoryObjectStoreLocalState();
    assert.equal(isCompactionCaughtUpWithManifest(manifest, laggingLocal), false);
    const skipped = await compactObjectStoreReplica(
      ctx(adapter, "22222222-2222-4222-8222-222222222222", laggingLocal),
      laggingLocal.load(),
      replica,
      { settleMs: 0 },
    );
    assert.equal(skipped.skipped, true);

    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-lag-cli-"));
    process.env.HOME = cliDir;
    fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");
    const newLocal = createInMemoryObjectStoreLocalState();
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({
      store: createCliSyncStore(),
      transport: transport(adapter, "55555555-5555-4555-8555-555555555555", newLocal),
    });
    assert.equal(fullSnapshot(createCliSyncStore().loadSyncReplica()), fullSnapshot(replica));
  });

  it("rejects replayed older manifest generation on pull", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerLocal = createInMemoryObjectStoreLocalState();
    const c = ctx(adapter, "11111111-1111-4111-8111-111111111111", writerLocal);
    await objectStorePushSyncMutations(c, [
      {
        client_id: "m1",
        op: "context_create",
        context_id: "ctx_man",
        payload: { context_id: "ctx_man", metadata: {} },
      },
    ]);
    const st = writerLocal.load();
    st.manifestGenerationHighWater = 999;
    await assert.rejects(
      () => loadStorageManifestForSync(adapter, TEST_DEK, LAYOUT_PREFIX, st),
      (err) => err instanceof PreconditionFailedError,
    );
    await writerLocal.save(st);
    await assert.rejects(
      () => objectStorePullSyncChanges(c, {}),
      (err) => err instanceof PreconditionFailedError,
    );
  });

  it("detects deleted log prefix when no verified snapshot applies", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    const c = ctx(adapter, writerUuid, writerLocal);
    for (let i = 0; i < 3; i += 1) {
      await objectStorePushSyncMutations(c, [
        {
          client_id: `pfx${i}`,
          op: "context_create",
          context_id: `ctx_pfx_${i}`,
          payload: { context_id: `ctx_pfx_${i}`, metadata: {} },
        },
      ]);
    }
    const head = writerLocal.load().trustedHeads[c.selfDevH];
    const { logSegmentRelativePath } = await import("../../lib/storage/layout.mjs");
    await adapter.delete(logSegmentRelativePath(LAYOUT_PREFIX, c.selfDevH, 0));
    await adapter.delete(logSegmentRelativePath(LAYOUT_PREFIX, c.selfDevH, 1));
    await assert.rejects(
      () => objectStorePushSyncMutations(c, [{ client_id: "pfx_tail", op: "context_create", context_id: "ctx_pfx_tail", payload: { context_id: "ctx_pfx_tail", metadata: {} } }]),
      /missing segment at seq 0|missing segment at seq/,
    );
    void head;
  });

  it("storage devices remove drops participant so GC can proceed", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const writerUuid = "11111111-1111-4111-8111-111111111111";
    const writerLocal = createInMemoryObjectStoreLocalState();
    const c = ctx(adapter, writerUuid, writerLocal);
    await objectStorePushSyncMutations(c, [
      {
        client_id: "g0",
        op: "context_create",
        context_id: "ctx_gc",
        payload: { context_id: "ctx_gc", metadata: {} },
      },
    ]);
    const lagDev = deriveDevH(TEST_DEK, "99999999-9999-4999-8999-999999999999");
    await updateStorageManifest(
      { adapter: c.adapter, dek: c.dek, layoutPrefix: c.layoutPrefix, ownerDevH: c.selfDevH, settleMs: 0 },
      (m) => {
        m.sync_participants = [...(m.sync_participants ?? []), lagDev];
        m.devices.push({ devH: lagDev, last_seq: 0, acknowledged_seq: 0 });
        return m;
      },
    );
    await removeManifestDevice(
      { adapter: c.adapter, dek: c.dek, layoutPrefix: c.layoutPrefix, ownerDevH: c.selfDevH, settleMs: 0 },
      lagDev,
    );
    const manifest = await loadStorageManifest(adapter, TEST_DEK, LAYOUT_PREFIX);
    assert.ok(!manifest.devices.some((row) => row.devH === lagDev));
  });
});
