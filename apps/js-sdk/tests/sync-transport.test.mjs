import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hostedSyncTransport } from "../lib/hosted-sync-transport.mjs";
import { getDefaultSyncTransport, setDefaultSyncTransport } from "../lib/sync-transport.mjs";
import * as syncApi from "../lib/sync-api.mjs";

describe("HostedSyncTransport", () => {
  it("registers as the default transport for sync-api re-exports", () => {
    assert.equal(getDefaultSyncTransport(), hostedSyncTransport);
    assert.equal(typeof syncApi.fetchSyncStatus, "function");
    assert.equal(typeof syncApi.pullSyncChanges, "function");
    assert.equal(typeof syncApi.pushSyncMutations, "function");
    assert.equal(typeof syncApi.fetchSyncConflicts, "function");
  });

  it("sync-api delegates to an injected transport", async () => {
    const calls = [];
    const mock = {
      fetchSyncStatus: async () => {
        calls.push("status");
        return { ok: true };
      },
      pullSyncChanges: async () => {
        calls.push("pull");
        return { changes: [] };
      },
      pushSyncMutations: async () => {
        calls.push("push");
        return { applied: [] };
      },
      fetchSyncConflicts: async () => {
        calls.push("conflicts");
        return { conflicts: [] };
      },
    };
    setDefaultSyncTransport(mock);
    try {
      await syncApi.fetchSyncStatus();
      await syncApi.pullSyncChanges({ since: 1 });
      await syncApi.pushSyncMutations([]);
      await syncApi.fetchSyncConflicts();
      assert.deepEqual(calls, ["status", "pull", "push", "conflicts"]);
    } finally {
      setDefaultSyncTransport(hostedSyncTransport);
    }
  });
});
