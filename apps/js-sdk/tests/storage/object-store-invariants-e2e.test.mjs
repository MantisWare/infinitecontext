import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createCliFileObjectStoreLocalState,
  createDaemonDbObjectStoreLocalState,
} from "../../lib/object-store-local-state-persist.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  compactObjectStoreReplica,
  confirmObjectStorePullDelivery,
  gcLogSegmentsCoveredByCompaction,
  verifySnapshotTrustedHeads,
} from "../../lib/storage/storage-compaction.mjs";
import { writeDeviceSyncAckFromState } from "../../lib/storage/storage-device-sync-ack.mjs";
import {
  objectStorePullSyncChanges,
  objectStorePushSyncMutations,
  resetObjectStorePullVerifyGenerationForTests,
} from "../../lib/object-store-sync.mjs";
import { pullAndApplySync, createCliSyncStore } from "../../lib/sync-engine.mjs";
import { createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { scenarioThreeUpdates } from "./object-store-replica-scenarios.mjs";

const TEST_DEK = new Uint8Array(32).fill(9);
const LAYOUT_PREFIX = "acct/invariants-e2e";

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

function transport(adapter, uuid, localState) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid: uuid,
    layoutPrefix: LAYOUT_PREFIX,
    localState,
  });
}

async function seedWriterCompacted(adapter) {
  const writerUuid = "11111111-1111-4111-8111-111111111111";
  const writerLocal = createInMemoryObjectStoreLocalState();
  const writerCtx = ctx(adapter, writerUuid, writerLocal);
  const items = sortMergeableMutations(scenarioThreeUpdates());
  for (const item of items) {
    await objectStorePushSyncMutations(writerCtx, [
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
  await compactObjectStoreReplica(writerCtx, writerLocal.load(), replica, { settleMs: 0 });
  await objectStorePushSyncMutations(writerCtx, [
    {
      client_id: "tail_k4",
      op: "context_create",
      context_id: "ctx_tail_k4",
      payload: { context_id: "ctx_tail_k4", metadata: { k: 4 } },
    },
  ]);
  await writeDeviceSyncAckFromState(writerCtx, writerLocal.load());
  return { writerCtx, writerLocal };
}

describe("object store compaction/GC invariants e2e", () => {
  it("bootstrap tail deferred until confirm (file-cli pullAndApplySync)", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const { writerCtx } = await seedWriterCompacted(adapter);
    const readerUuid = "22222222-2222-4222-8222-222222222222";
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-inv-cli-home-"));
    process.env.HOME = cliDir;
    fs.mkdirSync(path.join(cliDir, ".infinitecontext"), { recursive: true });
    fs.writeFileSync(path.join(cliDir, ".infinitecontext", "sync-replica.json"), "{}\n");
    const filePath = path.join(cliDir, ".infinitecontext", "object-store-sync-state.json");
    const reload = () => createCliFileObjectStoreLocalState(filePath);
    const store = createCliSyncStore();
    resetObjectStorePullVerifyGenerationForTests();
    await pullAndApplySync({
      store,
      transport: transport(adapter, readerUuid, reload()),
    });
    const after = reload().load();
    assert.equal(after.pendingPullDeliveryApply, undefined);
    assert.ok((after.vectorCursor?.v?.[writerCtx.selfDevH] ?? -1) >= 0);
    assert.equal(after.bootstrapReplicaPendingAck, false);
  });

  for (const label of ["file-state", "daemon.db"]) {
    it(`bootstrap tail deferred until confirm (${label})`, async () => {
      const adapter = createMemoryStorageAdapter();
      await adapter.init();
      const { writerCtx } = await seedWriterCompacted(adapter);
      const readerUuid = "22222222-2222-4222-8222-222222222222";
      let reload;
      if (label === "daemon.db") {
        const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-inv-db-")), "daemon.db");
        reload = () => createDaemonDbObjectStoreLocalState(dbFile);
      } else {
        const filePath = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "ic-inv-file-")),
          "object-store-sync-state.json",
        );
        reload = () => createCliFileObjectStoreLocalState(filePath);
      }
      const readerCtx = ctx(adapter, readerUuid, reload());
      resetObjectStorePullVerifyGenerationForTests();
      const page = await objectStorePullSyncChanges(readerCtx, { limit: 500 });
      assert.ok(page.bootstrap_replica);
      assert.ok((page.changes ?? []).length >= 1);

      const mid = reload().load();
      assert.ok(mid.pendingPullDeliveryApply);
      assert.ok(mid.bootstrapReplicaPendingAck);
      const persistedCursor = mid.vectorCursor?.v?.[writerCtx.selfDevH] ?? -1;
      const pendingCursor = mid.pendingPullDeliveryApply?.vectorCursor?.v?.[writerCtx.selfDevH];
      assert.ok(pendingCursor > persistedCursor);

      await confirmObjectStorePullDelivery(readerCtx);
      const after = reload().load();
      assert.equal(after.pendingPullDeliveryApply, undefined);
      assert.equal(after.vectorCursor?.v?.[writerCtx.selfDevH], pendingCursor);
      const backend = reload();
      if (backend.close) backend.close();
    });
  }

  it("crash before confirm leaves tail recoverable on disk (file-state)", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const { writerCtx } = await seedWriterCompacted(adapter);
    const readerUuid = "66666666-6666-4666-8666-666666666666";
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ic-crash-pre-confirm-")),
      "object-store-sync-state.json",
    );
    const reload = () => createCliFileObjectStoreLocalState(filePath);
    const readerCtx = ctx(adapter, readerUuid, reload());
    resetObjectStorePullVerifyGenerationForTests();
    await objectStorePullSyncChanges(readerCtx, { limit: 500 });
    const crashed = reload().load();
    assert.ok(crashed.pendingPullDeliveryApply);
    resetObjectStorePullVerifyGenerationForTests();
    const retry = await objectStorePullSyncChanges(ctx(adapter, readerUuid, reload()), { limit: 500 });
    assert.ok((retry.changes ?? []).length >= 1);
    await confirmObjectStorePullDelivery(ctx(adapter, readerUuid, reload()));
    assert.equal(reload().load().pendingPullDeliveryApply, undefined);
    assert.ok(reload().load().vectorCursor?.v?.[writerCtx.selfDevH] >= 0);
  });

  for (const backend of ["file", "daemon.db"]) {
    it(`sequential new devices join after compaction (${backend})`, async () => {
      const adapter = createMemoryStorageAdapter();
      await adapter.init();
      const { writerCtx } = await seedWriterCompacted(adapter);
      const uuids = [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ];
      for (const uuid of uuids) {
        let local;
        if (backend === "file") {
          const filePath = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), "ic-seq-")),
            "object-store-sync-state.json",
          );
          local = createCliFileObjectStoreLocalState(filePath);
        } else {
          const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-seq-db-")), "daemon.db");
          local = createDaemonDbObjectStoreLocalState(dbFile);
        }
        const readerCtx = ctx(adapter, uuid, local);
        resetObjectStorePullVerifyGenerationForTests();
        const page = await objectStorePullSyncChanges(readerCtx, { limit: 500 });
        assert.ok(page.bootstrap_replica);
        await confirmObjectStorePullDelivery(readerCtx);
        if (local.close) local.close();
      }
      await objectStorePushSyncMutations(writerCtx, [
        {
          client_id: "after_join",
          op: "context_create",
          context_id: "ctx_after_join",
          payload: { context_id: "ctx_after_join", metadata: {} },
        },
      ]);
      const replica = createEmptySyncReplica();
      const compact = await compactObjectStoreReplica(
        writerCtx,
        writerCtx.localState.load(),
        replica,
        { settleMs: 0 },
      );
      assert.notEqual(compact.skipped, true);
    });
  }

  it("rejects forged inactive snapshot head when live log exists", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const { writerCtx } = await seedWriterCompacted(adapter);
    const { loadStorageSnapshot } = await import("../../lib/storage/storage-compaction.mjs");
    const snap = await loadStorageSnapshot(writerCtx, 0);
    assert.ok(snap);
    snap.trusted_heads[writerCtx.selfDevH] = { seq: -1, digest: "" };
    await assert.rejects(() => verifySnapshotTrustedHeads(writerCtx, snap), /inactive|live log/i);
  });
});
