import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { encryptVaultPlaintextForStoragePut } from "../../lib/storage/encrypt-storage-object.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import {
  assertUsableHomeForLocalObjectStore,
  createLocalObjectStore,
  defaultLocalObjectStoreRootDir,
  LOCAL_OBJECT_STORE_BACKEND_ID,
  resolveLocalObjectStoreRootDir,
} from "../../lib/storage/local-object-store.mjs";

describe("local object store (PR 5)", () => {
  it("resolves root from env then config then default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-local-store-resolve-"));
    assert.equal(
      resolveLocalObjectStoreRootDir({
        env: { INFINITECONTEXT_OBJECT_STORE_ROOT: tmp },
        config: { storage: { rootDir: "/ignored" } },
      }),
      path.resolve(tmp),
    );
    assert.equal(
      resolveLocalObjectStoreRootDir({
        env: {},
        config: { storage: { rootDir: tmp } },
      }),
      path.resolve(tmp),
    );
    assert.equal(defaultLocalObjectStoreRootDir().endsWith(`${path.sep}object-store`), true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("createLocalObjectStore wires persisted ObjectStoreSyncTransport for daemon mode", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-local-store-daemon-"));
    const dbPath = path.join(rootDir, "daemon.db");
    const dek = new Uint8Array(32).fill(7);
    const deviceUuid = "44444444-4444-4444-8444-444444444444";
    const store = await createLocalObjectStore({
      rootDir,
      dek,
      deviceUuid,
      sync: { mode: "daemon", dbPath, persist: true },
    });
    assert.equal(typeof store.transport.pushSyncMutations, "function");
    await store.close();
    assert.ok(fs.existsSync(dbPath));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("createLocalObjectStore returns sealed transport over filesystem adapter", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-local-store-open-"));
    const dek = new Uint8Array(32).fill(9);
    const store = await createLocalObjectStore({ rootDir });
    assert.equal(store.adapter.id, LOCAL_OBJECT_STORE_BACKEND_ID);
    assert.equal("adapter" in store.transport, false);

    const key = "local/demo.enc";
    const sealed = encryptVaultPlaintextForStoragePut(dek, key, { note: "local store" });
    await store.transport.putObject(key, sealed, { ifNoneMatch: "*" });
    assert.ok(await store.transport.headObject(key));
    await store.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("rejects empty HOME and relative object store roots", () => {
    assert.throws(
      () => assertUsableHomeForLocalObjectStore({ env: { HOME: "" } }),
      (error) => error instanceof StorageError && error.code === "invalid_argument",
    );
    assert.throws(
      () =>
        resolveLocalObjectStoreRootDir({
          env: { INFINITECONTEXT_OBJECT_STORE_ROOT: "relative/store" },
        }),
      (error) => error instanceof StorageError && error.code === "invalid_argument",
    );
  });
});
