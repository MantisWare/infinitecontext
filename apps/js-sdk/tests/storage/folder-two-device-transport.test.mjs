import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { SimulatedEventualCopier } from "./helpers/folder-eventual-copier.mjs";

const TEST_DEK = new Uint8Array(32).fill(9);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT_PREFIX = "accounts/folder-e2e";

/**
 * @param {import("../../lib/storage/folder-adapter.mjs").createFolderStorageAdapter extends (...args: any) => infer R ? R : never} adapter
 * @param {string} deviceUuid
 * @param {import("../../lib/storage/object-store-sync-transport.mjs").ObjectStoreSyncTransportOptions} [extra]
 */
function createTransport(adapter, deviceUuid, extra = {}) {
  return new ObjectStoreSyncTransport(adapter, {
    dek: TEST_DEK,
    deviceUuid,
    layoutPrefix: LAYOUT_PREFIX,
    localState: createInMemoryObjectStoreLocalState(),
    ...extra,
  });
}

async function pushCreate(transport, metadata = { source: "test" }) {
  const client_id = generateClientNodeId();
  return transport.pushSyncMutations([
    {
      client_id,
      op: "context_create",
      payload: { metadata },
    },
  ]);
}

describe("folder two-device eventual sync transport", () => {
  it("converges through delayed out-of-order copier sync", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-b-"));
    const adapterA = createFolderStorageAdapter({ rootDir: dirA, placeholderTimeoutMs: 200 });
    const adapterB = createFolderStorageAdapter({ rootDir: dirB, placeholderTimeoutMs: 200 });
    await adapterA.init();
    await adapterB.init();
    const copier = new SimulatedEventualCopier(dirA, dirB);

    const transportA = createTransport(adapterA, DEVICE_A);
    const transportB = createTransport(adapterB, DEVICE_B);

    await pushCreate(transportA, { source: "from-a" });
    await copier.sync("AtoB", { delayMs: 5, shuffle: true });

    const pulledB = await transportB.pullSyncChanges({
      since: normalizeVectorSyncCursor(0),
      limit: 50,
    });
    assert.equal(pulledB.changes.length, 1);
    assert.equal(pulledB.changes[0].payload.metadata.source, "from-a");

    await pushCreate(transportB, { source: "from-b" });
    await copier.sync("BtoA", { delayMs: 5, shuffle: true });
    await copier.sync("AtoB", { delayMs: 5, shuffle: true });

    const catchUpA = await transportA.pullSyncChanges({
      since: normalizeVectorSyncCursor(0),
      limit: 50,
    });
    assert.ok(catchUpA.changes.some((c) => c.payload?.metadata?.source === "from-b"));
  });

  it("ingests iCloud-style conflict copy segments without silent trust", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-conf-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-conf-b-"));
    const adapterA = createFolderStorageAdapter({ rootDir: dirA, placeholderTimeoutMs: 200 });
    const adapterB = createFolderStorageAdapter({ rootDir: dirB, placeholderTimeoutMs: 200 });
    await adapterA.init();
    await adapterB.init();
    const transportA = createTransport(adapterA, DEVICE_A);
    await pushCreate(transportA, { source: "conflict-seed" });

    const listed = await adapterA.list(`${LAYOUT_PREFIX}/ic-v1/log/`);
    const segment = listed.objects.find((row) => row.key.includes("/log/"));
    assert.ok(segment);
    const { keyDir } = objectKeyDirectory(dirA, segment.key);
    const parent = path.dirname(keyDir);
    const conflictName = segment.key.split("/").pop().replace(/\.enc$/, " 2.enc");
    fs.cpSync(keyDir, path.join(parent, conflictName), { recursive: true });
    await new SimulatedEventualCopier(dirA, dirB).sync("AtoB");

    const transportB = createTransport(adapterB, DEVICE_B);
    const pulled = await transportB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 50 });
    assert.equal(pulled.changes.length, 1);
    assert.equal(pulled.changes[0].payload.metadata.source, "conflict-seed");
  });

  it("survives simulated kill -9 during segment write (idempotent client_id)", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-kill-"));
    const adapter = createFolderStorageAdapter({ rootDir, placeholderTimeoutMs: 200 });
    await adapter.init();
    const local = createInMemoryObjectStoreLocalState();
    const client_id = generateClientNodeId();
    const mutation = {
      client_id,
      op: "context_create",
      payload: { metadata: { source: "kill-test" } },
    };
    const crashed = createTransport(adapter, DEVICE_A, {
      localState: local,
      testHookAfterSegmentWrite: () => {},
      testHookSkipLocalSaveAfterSegmentWrite: true,
    });
    await crashed.pushSyncMutations([mutation]);
    const recovered = createTransport(adapter, DEVICE_A, local);
    const retry = await recovered.pushSyncMutations([mutation]);
    assert.deepEqual(retry.applied, []);
    assert.deepEqual(retry.duplicate, [client_id]);
  });
});
