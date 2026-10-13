import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertStorageCiphertext,
  buildStorageObjectBytes,
  isValidStorageAad,
} from "../../lib/storage/ciphertext.mjs";

const AAD = "ic-storage|log|devH|42";
const SAMPLE_NONCE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("assertStorageCiphertext", () => {
  it("accepts strict storage object with AAD", () => {
    const body = buildStorageObjectBytes(AAD, {
      __ic_enc: 1,
      kid: "dek_v1",
      v: 1,
      alg: "XC20P",
      nonce: SAMPLE_NONCE_B64,
      ct: "AA==",
    });
    assert.doesNotThrow(() => assertStorageCiphertext(body));
    assert.ok(isValidStorageAad(AAD));
  });

  it("rejects envelope bypass fields and plaintext ct", () => {
    const bypass = new TextEncoder().encode(
      JSON.stringify({
        ic_storage_v: 1,
        aad: AAD,
        enc: {
          __ic_enc: 1,
          kid: "dek_v1",
          v: 1,
          alg: "XC20P",
          nonce: SAMPLE_NONCE_B64,
          ct: "AA==",
        },
        messages: [{ text: "leak" }],
      }),
    );
    assert.throws(() => assertStorageCiphertext(bypass));

    const plaintextCt = new TextEncoder().encode(
      JSON.stringify({
        ic_storage_v: 1,
        aad: AAD,
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
    assert.throws(() => assertStorageCiphertext(plaintextCt));
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
