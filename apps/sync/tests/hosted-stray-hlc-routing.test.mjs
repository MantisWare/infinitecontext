import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { serializeMutationHlc } from "../../js-sdk/lib/object-store-hlc.mjs";
import { deriveDevH } from "../../js-sdk/lib/storage/layout.mjs";
import { createStore } from "../src/store.mjs";

const TEST_DEK = new Uint8Array(32).fill(3);

describe("hosted daemon routing", () => {
  it("routes stray object-store-shaped changes to sync_message_nodes when pull disabled", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-hosted-stray-")), "daemon.db");
    const store = createStore({ dbPath });
    const devH = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
    try {
      await store.initObjectStoreReplica({ objectStoreBackend: false });
      assert.equal(store.objectStoreReplicaPullEnabled, false);
      store.applySyncChange({
        op: "message_append",
        context_id: "ctx_stray",
        sequence: 1,
        hlc: serializeMutationHlc({ wall_ms: 1000, counter: 0, devH }),
        source_dev_h: devH,
        source_seq: 0,
        source_index: 0,
        payload: {
          context_id: "ctx_stray",
          data: [{ id: "icn_stray", role: "user", metadata: { ic_client_node_id: "icn_stray" } }],
        },
      });
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT COUNT(*) AS c FROM sync_message_nodes WHERE client_node_id = ?").get("icn_stray");
      assert.equal(Number(row.c), 1);
      const replica = store.loadSyncReplica();
      assert.equal(replica.messages.icn_stray, undefined);
    } finally {
      store.close();
    }
  });
});
