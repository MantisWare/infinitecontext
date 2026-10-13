import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildStorageObjectBytes } from "../../lib/storage/ciphertext.mjs";
import { encryptVaultPlaintextForStoragePut } from "../../lib/storage/encrypt-storage-object.mjs";
import * as storagePublic from "../../lib/storage/index.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const SAMPLE_NONCE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY = "accounts/demo/log-0001.enc";
const PLAINTEXT_EXFIL = "my bank PIN is 4471 hunter2";

describe("ObjectStoreSyncTransport put sealing", () => {
  it("public storage index does not export seal bypass helpers", () => {
    assert.equal("markStoragePutBodySealed" in storagePublic, false);
    assert.equal("encryptStorageObjectForPut" in storagePublic, false);
    assert.equal("assertStoragePutBodySealed" in storagePublic, false);
  });

  it("does not expose adapter for direct put bypass", () => {
    const transport = new ObjectStoreSyncTransport(createMemoryStorageAdapter());
    assert.equal("adapter" in transport, false);
  });

  it("accepts bodies from encryptVaultPlaintextForStoragePut", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    const dek = new Uint8Array(32).fill(7);
    const sealed = encryptVaultPlaintextForStoragePut(dek, KEY, { note: "vault path" });
    await transport.putObject(KEY, sealed, { ifNoneMatch: "*" });
    assert.ok(await transport.headObject(KEY));
  });

  it("rejects unsealed bodies built with buildStorageObjectBytes", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    const validCt = Buffer.alloc(16, 0).toString("base64");
    const unsealed = buildStorageObjectBytes(KEY, {
      __ic_enc: 1,
      kid: "dek_v1",
      v: 1,
      alg: "XC20P",
      nonce: SAMPLE_NONCE_B64,
      ct: validCt,
    });
    await assert.rejects(() => transport.putObject(KEY, unsealed, { ifNoneMatch: "*" }));
  });

  it("rejects plaintext exfil in enc.ct even when shape validates", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    const ctB64 = Buffer.from(PLAINTEXT_EXFIL, "utf8").toString("base64");
    assert.ok(Buffer.from(ctB64, "base64").length >= 16);
    const malicious = buildStorageObjectBytes(KEY, {
      __ic_enc: 1,
      kid: "dek_v1",
      v: 1,
      alg: "XC20P",
      nonce: SAMPLE_NONCE_B64,
      ct: ctB64,
    });
    await assert.rejects(() => transport.putObject(KEY, malicious, { ifNoneMatch: "*" }));
  });

  it("rejects all-zero DEK at encrypt time", () => {
    const zeroDek = new Uint8Array(32);
    assert.throws(
      () => encryptVaultPlaintextForStoragePut(zeroDek, KEY, { x: 1 }),
      /all-zero/,
    );
  });

  it("rejects invalid DEK length at encrypt time", () => {
    assert.throws(
      () => encryptVaultPlaintextForStoragePut(new Uint8Array(16).fill(1), KEY, { x: 1 }),
      /32-byte/,
    );
  });

  it("stores a copy so mutating caller buffer after put does not change backing object", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    const dek = new Uint8Array(32).fill(9);
    const sealed = encryptVaultPlaintextForStoragePut(dek, KEY, { v: 1 });
    await transport.putObject(KEY, sealed, { ifNoneMatch: "*" });
    const got = await transport.getObject(KEY);
    assert.ok(got?.body);
    const storedSnapshot = new Uint8Array(got.body);
    sealed[0] ^= 0xff;
    const afterMutate = await transport.getObject(KEY);
    assert.ok(afterMutate?.body);
    assert.deepEqual(afterMutate.body, storedSnapshot);
  });

  it("rejects bodies mutated after encryption", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    const dek = new Uint8Array(32).fill(3);
    const sealed = encryptVaultPlaintextForStoragePut(dek, KEY, { ok: true });
    sealed[sealed.length - 1] ^= 0xff;
    await assert.rejects(() => transport.putObject(KEY, sealed, { ifNoneMatch: "*" }));
  });
});
