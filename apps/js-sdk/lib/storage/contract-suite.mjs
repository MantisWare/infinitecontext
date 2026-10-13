import assert from "node:assert/strict";

import { assertStorageCiphertext } from "./ciphertext.mjs";
import { PreconditionFailedError } from "./memory-adapter.mjs";
import { STORAGE_CAPABILITIES } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

/** @returns {Uint8Array} */
export function sampleEncryptedObjectBytes() {
  const envelope = {
    __ic_enc: 1,
    kid: "dek_v1",
    v: 1,
    alg: "XC20P",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
    ct: "AA==",
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/**
 * Shared contract every StorageAdapter must satisfy.
 * @param {() => StorageAdapter | Promise<StorageAdapter>} createAdapter
 * @param {{ describe: Function, it: Function }} test
 */
export function runStorageAdapterContractSuite(createAdapter, { describe, it }) {
  describe("StorageAdapter contract", () => {
    /** @type {StorageAdapter} */
    let adapter;

    it("exposes required capabilities", async () => {
      adapter = await createAdapter();
      for (const cap of [
        STORAGE_CAPABILITIES.get,
        STORAGE_CAPABILITIES.head,
        STORAGE_CAPABILITIES.put,
        STORAGE_CAPABILITIES.list,
        STORAGE_CAPABILITIES.delete,
        STORAGE_CAPABILITIES.conditionalWrite,
      ]) {
        assert.ok(adapter.capabilities.has(cap), `missing capability ${cap}`);
      }
    });

    it("round-trips ciphertext with head/get/list/delete", async () => {
      adapter = await createAdapter();
      const body = sampleEncryptedObjectBytes();
      const ref = await adapter.put("accounts/demo/blobs/a.enc", body);
      assert.equal(ref.key, "accounts/demo/blobs/a.enc");
      assert.ok(ref.etag);

      const head = await adapter.head("accounts/demo/blobs/a.enc");
      assert.ok(head);
      assert.equal(head.size, body.length);
      assert.equal(head.etag, ref.etag);

      const got = await adapter.get("accounts/demo/blobs/a.enc");
      assert.ok(got);
      assert.deepEqual(got.body, body);
      assert.equal(got.etag, ref.etag);

      const listed = await adapter.list("accounts/demo/");
      assert.ok(listed.objects.some((row) => row.key === ref.key));

      await adapter.delete("accounts/demo/blobs/a.enc");
      assert.equal(await adapter.get("accounts/demo/blobs/a.enc"), null);
    });

    it("enforces ifNoneMatch create-only and ifMatch updates", async () => {
      adapter = await createAdapter();
      const first = sampleEncryptedObjectBytes();
      const second = sampleEncryptedObjectBytes();
      second[second.length - 1] ^= 0xff;

      await adapter.put("manifest.json", first, { ifNoneMatch: "*" });
      await assert.rejects(
        () => adapter.put("manifest.json", second, { ifNoneMatch: "*" }),
        (err) => err instanceof PreconditionFailedError,
      );

      const head = await adapter.head("manifest.json");
      await adapter.put("manifest.json", second, { ifMatch: head?.etag });
      const got = await adapter.get("manifest.json");
      assert.deepEqual(got?.body, second);

      await assert.rejects(
        () => adapter.put("manifest.json", first, { ifMatch: '"stale"' }),
        (err) => err instanceof PreconditionFailedError,
      );
    });

    it("rejects plaintext writes", async () => {
      adapter = await createAdapter();
      const plaintext = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
      await assert.rejects(() => adapter.put("blobs/plain.json", plaintext));
      assert.throws(() => assertStorageCiphertext(plaintext));
    });

    it("never stores plaintext even when put is attempted with raw bytes", async () => {
      adapter = await createAdapter();
      const ascii = new TextEncoder().encode("not encrypted");
      await assert.rejects(() => adapter.put("blobs/x.enc", ascii));
      assert.equal(await adapter.get("blobs/x.enc"), null);
    });
  });
}
