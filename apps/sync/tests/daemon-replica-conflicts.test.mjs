import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createEmptySyncReplica } from "../../js-sdk/lib/sync-replica-apply.mjs";
import { assertDaemonStoreConvergesAcrossRandomPulls, syncChangeFromMergeable } from "../../js-sdk/tests/helpers/object-store-replica-convergence.mjs";
import { ALL_CONVERGENCE_SCENARIOS } from "../../js-sdk/tests/storage/object-store-replica-scenarios.mjs";
import { createStore } from "../src/store.mjs";

describe("daemon.db object-store replica", () => {
  for (const [label, scenarioFn] of ALL_CONVERGENCE_SCENARIOS) {
    it(`${label} — full rows match across 300 random pull orders`, async () => {
      const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-replica-")), "daemon.db");
      const store = createStore({ dbPath });
      try {
        await store.initObjectStoreReplica();
        assertDaemonStoreConvergesAcrossRandomPulls(scenarioFn(), {
          applySyncChange: (change) => store.applySyncChange(change),
          load: () => store.loadSyncReplica(),
          clearReplicaCache: () => store.clearReplicaCache(),
          reset: () => {
            store.flushSyncReplica(createEmptySyncReplica());
            store.clearReplicaCache();
          },
        });
      } finally {
        store.close();
      }
    });
  }

  it("applySyncChange routes object-store changes through the replica table", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-apply-")), "daemon.db");
    const store = createStore({ dbPath });
    try {
      await store.initObjectStoreReplica();
      const change = syncChangeFromMergeable(ALL_CONVERGENCE_SCENARIOS[0][1]()[1]);
      store.applySyncChange(change);
      const row = store.loadSyncReplica();
      assert.ok(row.messages && Object.keys(row.messages).length > 0);
    } finally {
      store.close();
    }
  });

  it("hosted message_delete still removes sync_message_nodes rows", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-hosted-")), "daemon.db");
    const store = createStore({ dbPath });
    try {
      await store.initObjectStoreReplica();
      store.applySyncChange({
        op: "message_append",
        context_id: "ctx_h",
        sequence: 1,
        payload: {
          context_id: "ctx_h",
          data: [{ id: "icn_hosted", role: "user", metadata: { ic_client_node_id: "icn_hosted" } }],
        },
      });
      store.applySyncChange({
        op: "message_delete",
        context_id: "ctx_h",
        sequence: 2,
        payload: { deleted_client_ids: ["icn_hosted"] },
      });
      const replica = store.loadSyncReplica();
      assert.equal(replica.messages.icn_hosted, undefined);
    } finally {
      store.close();
    }
  });
});
