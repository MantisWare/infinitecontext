import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { applySyncChangeToReplica, createEmptySyncReplica } from "../../lib/sync-replica-apply.mjs";
import { sanitizeSyncReplicaForPersist } from "../../lib/sync-replica-state.mjs";
import { sortMergeableMutations } from "../../lib/object-store-merge.mjs";
import { fullSnapshot, syncChangeFromMergeable } from "../helpers/object-store-replica-convergence.mjs";
import { scenarioAppendDeleteSlowUpdate } from "./object-store-replica-scenarios.mjs";

describe("CLI and daemon replicas", () => {
  it("match persisted state after the same object-store pull batch", async () => {
    const items = sortMergeableMutations(scenarioAppendDeleteSlowUpdate());
    const cliReplica = createEmptySyncReplica();
    for (const item of items) {
      applySyncChangeToReplica(cliReplica, syncChangeFromMergeable(item), () => {});
    }
    const cliPersisted = sanitizeSyncReplicaForPersist(cliReplica);

    const { createStore } = await import("../../../sync/src/store.mjs");
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-match-")), "daemon.db");
    const store = createStore({ dbPath });
    try {
      const daemonReplica = store.loadSyncReplica();
      for (const item of items) {
        applySyncChangeToReplica(daemonReplica, syncChangeFromMergeable(item), () => {});
      }
      store.flushSyncReplica(daemonReplica);
      const daemonPersisted = sanitizeSyncReplicaForPersist(store.loadSyncReplica());
      assert.equal(JSON.stringify(daemonPersisted), JSON.stringify(cliPersisted));
      assert.equal(fullSnapshot(cliReplica), fullSnapshot(store.loadSyncReplica()));
    } finally {
      store.close();
    }
  });
});
