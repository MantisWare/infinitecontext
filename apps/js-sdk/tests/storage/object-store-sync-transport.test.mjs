import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildStorageObjectBytes } from "../../lib/storage/ciphertext.mjs";
import {
  encryptStorageObjectForPut,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const SAMPLE_NONCE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_CT_B64 = Buffer.alloc(16, 0).toString("base64");
const KEY = "accounts/demo/log-0001.enc";

function sampleEnvelope() {
  return {
    __ic_enc: 1,
    kid: "dek_v1",
    v: 1,
    alg: "XC20P",
    nonce: SAMPLE_NONCE_B64,
    ct: VALID_CT_B64,
  };
}

describe("ObjectStoreSyncTransport put sealing", () => {
  it("accepts only bodies from encryptStorageObjectForPut", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    const sealed = encryptStorageObjectForPut(KEY, sampleEnvelope());
    await transport.putObject(KEY, sealed, { ifNoneMatch: "*" });
    const got = await transport.getObject(KEY);
    assert.ok(got?.body);

    const unsealed = buildStorageObjectBytes(KEY, sampleEnvelope());
    await assert.rejects(() => transport.putObject("other.enc", unsealed, { ifNoneMatch: "*" }));
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
});
