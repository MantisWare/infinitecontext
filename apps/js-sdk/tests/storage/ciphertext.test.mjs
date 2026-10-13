import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertStorageCiphertext,
  buildStorageAadForKey,
  buildStorageObjectBytes,
  isValidStorageAad,
} from "../../lib/storage/ciphertext.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";

const SAMPLE_NONCE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_CT_B64 = Buffer.alloc(16, 0).toString("base64");
const KEY = "accounts/demo/object.enc";

describe("assertStorageCiphertext", () => {
  it("accepts strict storage object with key-bound AAD", () => {
    const aad = buildStorageAadForKey(KEY);
    const body = buildStorageObjectBytes(KEY, {
      __ic_enc: 1,
      kid: "dek_v1",
      v: 1,
      alg: "XC20P",
      nonce: SAMPLE_NONCE_B64,
      ct: VALID_CT_B64,
    });
    assert.doesNotThrow(() => assertStorageCiphertext(body, { objectKey: KEY }));
    assert.equal(aad, buildStorageAadForKey(KEY));
    assert.ok(isValidStorageAad(aad));
  });

  it("rejects ct shorter than Poly1305 tag size", () => {
    assert.throws(() =>
      buildStorageObjectBytes(KEY, {
        __ic_enc: 1,
        kid: "dek_v1",
        v: 1,
        alg: "XC20P",
        nonce: SAMPLE_NONCE_B64,
        ct: "AA==",
      }),
    );
  });

  it("adapter shape check cannot detect base64 JSON in ct (ObjectStore requires seal)", async () => {
    const manualCt = new TextEncoder().encode(
      JSON.stringify({
        ic_storage_v: 1,
        aad: buildStorageAadForKey(KEY),
        enc: {
          __ic_enc: 1,
          kid: "dek_v1",
          v: 1,
          alg: "XC20P",
          nonce: SAMPLE_NONCE_B64,
          ct: Buffer.from('{"hello":"world"}').toString("base64"),
        },
      }),
    );
    assert.doesNotThrow(() => assertStorageCiphertext(manualCt, { objectKey: KEY }));
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const transport = new ObjectStoreSyncTransport(adapter);
    await assert.rejects(() => transport.putObject(KEY, manualCt, { ifNoneMatch: "*" }));
  });

  it("rejects AAD/key mismatch on put", () => {
    const body = buildStorageObjectBytes(KEY, {
      __ic_enc: 1,
      kid: "dek_v1",
      v: 1,
      alg: "XC20P",
      nonce: SAMPLE_NONCE_B64,
      ct: VALID_CT_B64,
    });
    assert.throws(() => assertStorageCiphertext(body, { objectKey: "other/key.enc" }));
  });

  it("rejects gzip plaintext and binary without wrapper", () => {
    const gzipPlain = gzipSync(Buffer.from(JSON.stringify({ hello: "world" })));
    assert.throws(() => assertStorageCiphertext(new Uint8Array(gzipPlain)));

    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    assert.throws(() => assertStorageCiphertext(binary));

    const utfPlain = new TextEncoder().encode("hello");
    assert.throws(() => assertStorageCiphertext(utfPlain));
  });
});
