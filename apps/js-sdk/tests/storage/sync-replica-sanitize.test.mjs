import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { sanitizeSyncReplicaForPersist } from "../../lib/sync-replica-state.mjs";
import { syncChangeFromMergeable } from "../helpers/object-store-replica-convergence.mjs";
import { scenarioAppendDeleteSlowUpdate, scenarioThreeUpdates } from "./object-store-replica-scenarios.mjs";
import { mergeableFromMutation } from "../../lib/object-store-merge.mjs";
import { msg, TEST_DEK } from "./object-store-replica-scenarios.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";

function scanForNeedle(value, needle) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes(needle);
}

describe("sanitizeSyncReplicaForPersist", () => {
  it("persisted mutation log is identical across 120 random apply orders", () => {
    const items = scenarioThreeUpdates();
    /** @type {string[]} */
    const shapes = [];
    for (let t = 0; t < 120; t += 1) {
      const order = [...items].sort(() => Math.random() - 0.5);
      const replica = createEmptySyncReplica();
      for (const item of order) {
        applySyncChangeToReplica(replica, syncChangeFromMergeable(item), () => {});
      }
      shapes.push(JSON.stringify(sanitizeSyncReplicaForPersist(replica)._message_mutations));
    }
    assert.equal(new Set(shapes).size, 1);
  });

  it("keeps tombstone_blocked_update loser text on persist", () => {
    const items = scenarioAppendDeleteSlowUpdate();
    const replica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(replica, syncChangeFromMergeable(item), () => {});
    }
    const lateConflict = replica.sync_conflicts.find(
      (c) => c.kind === "tombstone_blocked_update" && JSON.stringify(c.right_payload).includes("after"),
    );
    assert.ok(lateConflict, "expected late-update tombstone_blocked_update conflict");

    const persisted = sanitizeSyncReplicaForPersist(replica);
    const persistedLate = persisted.sync_conflicts.find(
      (c) => c.kind === "tombstone_blocked_update" && JSON.stringify(c.right_payload).includes("after"),
    );
    assert.ok(persistedLate?.right_payload?.data, "concurrent loser text should be kept on persist");
    assert.ok(JSON.stringify(persistedLate.right_payload).includes("after"));

    const appendConflict = persisted.sync_conflicts.find(
      (c) => c.kind === "tombstone_blocked_update" && String(c.right_payload?.op ?? "") === "message_append",
    );
    assert.equal(appendConflict?.right_payload?.data, null, "delete-covered append loser text is stripped");
  });

  it("drops superseded plaintext from persist when causally covered", async () => {
    const items = scenarioThreeUpdates();
    const secretMid = "u2";
    const secretOld = "u1";
    const replica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(replica, syncChangeFromMergeable(item), () => {});
    }
    assert.equal(replica.messages.icn_three_msg.payload.content.body, "u3");

    const persisted = sanitizeSyncReplicaForPersist(replica);
    assert.equal(scanForNeedle(persisted, secretOld), false, "superseded u1 should be stripped from log");
    assert.equal(scanForNeedle(persisted, secretMid), false, "superseded u2 should be stripped from log");
    assert.ok(scanForNeedle(persisted, "u3"), "winner u3 may remain on current winner entry");

    const { createStore } = await import("../../../sync/src/store.mjs");
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-sup-")), "daemon.db");
    const store = createStore({ dbPath });
    try {
      await store.initObjectStoreReplica();
      store.flushSyncReplica(replica);
      store.clearReplicaCache();
      const raw = fs.readFileSync(dbPath, "utf8");
      assert.equal(raw.includes(secretOld), false, "superseded secret absent from daemon.db");
      assert.equal(scanForNeedle(store.loadSyncReplica(), secretOld), false);
    } finally {
      store.close();
    }
  });

  it("does not leave deleted secret in daemon.db or WAL after close and reopen", async () => {
    const secret = "SECRET-BIG-DELETED-MARKER-XY";
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_db_priv";
    const msgId = "icn_db_priv";
    const deleteBase = { kind: "vector", v: { [devA]: 1 } };
    const replica = createEmptySyncReplica();
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          { client_id: "p0", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, secret)] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
          devA, 1, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
        ),
      ),
      () => {},
    );
    applySyncChangeToReplica(
      replica,
      syncChangeFromMergeable(
        mergeableFromMutation(
          {
            client_id: "p1",
            op: "message_delete",
            context_id: ctx,
            base_vector: deleteBase,
            payload: { ids: [msgId], base_vector: deleteBase },
            hlc: { wall_ms: 4000, counter: 0, devH: devA },
          },
          devA, 2, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
        ),
      ),
      () => {},
    );

    const { createStore } = await import("../../../sync/src/store.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-db-priv-"));
    const dbPath = path.join(dir, "daemon.db");
    let store = createStore({ dbPath });
    try {
      await store.initObjectStoreReplica();
      store.applySyncChange(
        syncChangeFromMergeable(
          mergeableFromMutation(
            { client_id: "p0", op: "message_append", context_id: ctx, payload: { messages: [msg(msgId, secret)] }, hlc: { wall_ms: 2000, counter: 0, devH: devA } },
            devA, 1, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
          ),
        ),
      );
      store.applySyncChange(
        syncChangeFromMergeable(
          mergeableFromMutation(
            {
              client_id: "p1",
              op: "message_delete",
              context_id: ctx,
              base_vector: deleteBase,
              payload: { ids: [msgId], base_vector: deleteBase },
              hlc: { wall_ms: 4000, counter: 0, devH: devA },
            },
            devA, 2, 0, "11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z",
          ),
        ),
      );
    } finally {
      store.close();
    }

    const walPath = `${dbPath}-wal`;
    const mainRaw = fs.readFileSync(dbPath);
    const walRaw = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
    assert.equal(mainRaw.includes(Buffer.from(secret)), false, "secret in main db");
    assert.equal(walRaw.includes(Buffer.from(secret)), false, "secret in wal");

    store = createStore({ dbPath });
    try {
      await store.initObjectStoreReplica();
      const row = store.loadSyncReplica();
      assert.equal(scanForNeedle(row, secret), false);
      const rawAfterReopen = fs.readFileSync(dbPath);
      assert.equal(rawAfterReopen.includes(Buffer.from(secret)), false, "secret in main db after reopen");
    } finally {
      store.close();
    }
  });
});
