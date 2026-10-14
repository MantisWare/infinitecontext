import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { generateClientNodeId } from "../lib/ic-crypto.mjs";
import {
  configureObjectStoreSyncTransportIfNeeded,
  resetObjectStoreBootstrapForTests,
} from "../lib/sync-object-store-bootstrap.mjs";
import { getDefaultSyncTransport, setDefaultSyncTransport } from "../lib/sync-transport.mjs";
import { hostedSyncTransport } from "../lib/hosted-sync-transport.mjs";
import { normalizeVectorSyncCursor } from "../lib/sync-cursor.mjs";

const TEST_DEK = new Uint8Array(32).fill(11);

describe("sync-object-store-bootstrap", () => {
  afterEach(async () => {
    await resetObjectStoreBootstrapForTests();
    setDefaultSyncTransport(hostedSyncTransport);
  });

  it("passes unlocked dek bytes into createLocalObjectStore and push/pull works", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ic-bootstrap-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const rootDir = fs.mkdtempSync(path.join(home, "object-store-root-"));
    const config = {
      storage: {
        backend: "local-filesystem",
        rootDir,
        deviceUuid: "55555555-5555-4555-8555-555555555555",
      },
    };

    const store = await configureObjectStoreSyncTransportIfNeeded({
      mode: "cli",
      config,
      baseUrl: "http://127.0.0.1:9",
      resolveUnlockedDek: async () => ({
        dek: TEST_DEK,
        accountKey: "acct-test",
        crypto: { initialized: true, dek_version: 1 },
        dekVersion: 1,
        userPublicId: "user-test",
      }),
    });
    assert.ok(store);
    assert.notEqual(getDefaultSyncTransport(), hostedSyncTransport);

    const transport = getDefaultSyncTransport();
    const contextId = "ctx_bootstrap_e2e";
    const clientId = generateClientNodeId();
    const pushed = await transport.pushSyncMutations([
      {
        client_id: clientId,
        op: "context_create",
        context_id: contextId,
        payload: { context_id: contextId, metadata: { source: "bootstrap-e2e" } },
      },
    ]);
    assert.equal(pushed.applied.length, 1);

    const pulled = await transport.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 50 });
    assert.equal(pulled.changes.length, 1);
    assert.equal(pulled.changes[0].op, "context_create");

    await store.close();
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
});
