import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { mergeableFromMutation } from "../../lib/object-store-merge.mjs";
import { sanitizeSyncReplicaForPersist } from "../../lib/sync-replica-state.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { syncChangeFromMergeable } from "../helpers/object-store-replica-convergence.mjs";
import { msg, TEST_DEK } from "./object-store-replica-scenarios.mjs";

function scanForNeedle(value, needle) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes(needle);
}

describe("sync replica privacy on persist", () => {
  it("drops deleted plaintext from CLI persist shape and daemon.db row", async () => {
    const secret = "super-secret-token-xyzzy-999";
    const devA = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    const ctx = "ctx_priv";
    const msgId = "icn_priv_msg";
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

    const persisted = sanitizeSyncReplicaForPersist(replica);
    assert.equal(scanForNeedle(persisted, secret), false);

    const { createStore } = await import("../../../sync/src/store.mjs");
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-priv-")), "daemon.db");
    const store = createStore({ dbPath });
    try {
      store.flushSyncReplica(replica);
      const row = store.dbPath;
      const raw = fs.readFileSync(dbPath, "utf8");
      assert.equal(raw.includes(secret), false);
      assert.equal(scanForNeedle(store.loadSyncReplica(), secret), false);
      void row;
    } finally {
      store.close();
    }
  });
});
