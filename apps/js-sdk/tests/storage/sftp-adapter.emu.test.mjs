import assert from "node:assert/strict";
import { describe, it, after, afterEach } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { runStorageAdapterContractSuite } from "../../lib/storage/contract-suite.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";
import { scanStorageObjectForLeaks } from "../../lib/storage/ciphertext.mjs";
import { readSftpPrivateKeyFile, createSftpStorageAdapter } from "../../lib/storage/sftp-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { sftpTestConfig } from "./helpers/sftp-emu.mjs";
import { getSftpEmuConfig, teardownSftpEmu } from "./helpers/sftp-emu-lazy.mjs";

const emu = getSftpEmuConfig();
const TEST_DEK = new Uint8Array(32).fill(3);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT = "accounts/sftp-e2e";

if (process.env.IC_REQUIRE_SFTP === "1") {
  after(() => {
    teardownSftpEmu();
  });
}

/** @type {import("../../lib/storage/types.mjs").StorageAdapter | null} */
let contractHarnessAdapter = null;

describe("sftp adapter emu", { skip: !emu }, () => {
  afterEach(async () => {
    if (contractHarnessAdapter) {
      await contractHarnessAdapter.close();
      contractHarnessAdapter = null;
    }
  });

  runStorageAdapterContractSuite(
    async () => {
      const cfg = emu;
      assert.ok(cfg);
      const { key } = readSftpPrivateKeyFile(cfg.privateKeyPath);
      const adapter = createSftpStorageAdapter({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        root: cfg.root,
        hostKeySha256: cfg.hostKeySha256,
        privateKey: key,
      });
      contractHarnessAdapter = adapter;
      return {
        adapter,
        inspectBacking: () => ({ keys: [], bodies: [], metadata: [] }),
      };
    },
    { describe, it, afterEach },
    {
      requiredCapabilities: [
        STORAGE_CAPABILITIES.get,
        STORAGE_CAPABILITIES.head,
        STORAGE_CAPABILITIES.put,
        STORAGE_CAPABILITIES.list,
        STORAGE_CAPABILITIES.delete,
        STORAGE_CAPABILITIES.conditionalCreate,
        STORAGE_CAPABILITIES.strongListAfterWrite,
      ],
      skipConditionalReplaceTests: true,
      skipConditionalDeleteIfMatchTests: true,
    },
  );

  it("two-device transport roundtrip with ciphertext-only remote", async () => {
    const cfg = emu;
    assert.ok(cfg);
    const { key } = readSftpPrivateKeyFile(cfg.privateKeyPath);
    const mkAdapter = () =>
      createSftpStorageAdapter({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        root: cfg.root,
        hostKeySha256: cfg.hostKeySha256,
        privateKey: key,
      });

    const adapterA = mkAdapter();
    const adapterB = mkAdapter();
    await adapterA.init();
    await adapterB.init();

    const transportA = new ObjectStoreSyncTransport(adapterA, {
      dek: TEST_DEK,
      deviceUuid: DEVICE_A,
      layoutPrefix: LAYOUT,
      localState: createInMemoryObjectStoreLocalState(),
    });
    const transportB = new ObjectStoreSyncTransport(adapterB, {
      dek: TEST_DEK,
      deviceUuid: DEVICE_B,
      layoutPrefix: LAYOUT,
      localState: createInMemoryObjectStoreLocalState(),
    });

    const client_id = generateClientNodeId();
    await transportA.pushSyncMutations([
      {
        client_id,
        op: "context_create",
        payload: { metadata: { marker: "PLAINTEXT-MARKER-SHOULD-NOT-APPEAR" } },
      },
    ]);

    const pulled = await transportB.pullSyncChanges({ since: normalizeVectorSyncCursor(0), limit: 20 });
    assert.equal(pulled.changes.length, 1);

    const listed = await adapterA.list(`${LAYOUT}/`);
    for (const row of listed.objects) {
      const got = await adapterA.get(row.key);
      assert.ok(got?.body);
      scanStorageObjectForLeaks(row.key, got.body);
      const text = new TextDecoder().decode(got.body);
      assert.ok(!text.includes("PLAINTEXT-MARKER-SHOULD-NOT-APPEAR"));
    }

    await adapterA.close();
    await adapterB.close();
  });

  it("resolveSftpObjectStoreConfig from test config", async () => {
    const { resolveSftpObjectStoreConfig } = await import("../../lib/storage/sftp-config.mjs");
    const resolved = resolveSftpObjectStoreConfig(sftpTestConfig(emu), {
      IC_SFTP_TEST_HOST: emu.host,
      IC_SFTP_TEST_PORT: String(emu.port),
    });
    assert.equal(resolved.username, "ic");
  });
});
