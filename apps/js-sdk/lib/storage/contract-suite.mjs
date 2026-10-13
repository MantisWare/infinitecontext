import assert from "node:assert/strict";

import { assertStorageCiphertext, buildStorageObjectBytes } from "./ciphertext.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import { STORAGE_CAPABILITIES } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

const SAMPLE_AAD = "ic-storage|log|devH|0";
const SAMPLE_NONCE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** @returns {Uint8Array} */
export function sampleEncryptedObjectBytes() {
  return buildStorageObjectBytes(SAMPLE_AAD, {
    __ic_enc: 1,
    kid: "dek_v1",
    v: 1,
    alg: "XC20P",
    nonce: SAMPLE_NONCE_B64,
    ct: "AA==",
  });
}

/** @returns {Uint8Array} */
function sampleEncryptedObjectBytesVariant(tagByte) {
  const ct = Buffer.from([tagByte, 0x01, 0x02, 0x03]).toString("base64");
  return buildStorageObjectBytes(SAMPLE_AAD, {
    __ic_enc: 1,
    kid: "dek_v1",
    v: 1,
    alg: "XC20P",
    nonce: SAMPLE_NONCE_B64,
    ct,
  });
}

/**
 * @typedef {Object} StorageAdapterTestHarness
 * @property {StorageAdapter} adapter
 * @property {() => { keys: string[], bodies: Uint8Array[] }} [inspectBacking]
 */

/**
 * Shared contract every StorageAdapter must satisfy.
 * @param {() => StorageAdapterTestHarness | Promise<StorageAdapterTestHarness>} createHarness
 * @param {{ describe: Function, it: Function }} test
 */
export function runStorageAdapterContractSuite(createHarness, { describe, it }) {
  describe("StorageAdapter contract", () => {
    /** @type {StorageAdapter} */
    let adapter;
    /** @type {(() => { keys: string[], bodies: Uint8Array[] }) | undefined} */
    let inspectBacking;

    /** @param {StorageAdapterTestHarness} harness */
    const useHarness = (harness) => {
      adapter = harness.adapter;
      inspectBacking = harness.inspectBacking;
    };

    const assertBackingIsCiphertextOnly = () => {
      if (!inspectBacking) return;
      const { keys, bodies } = inspectBacking();
      for (const key of keys) {
        assert.doesNotMatch(String(key), /password|plaintext|secret/i, `backing key leaks plaintext hint: ${key}`);
      }
      for (const body of bodies) {
        assert.doesNotThrow(() => assertStorageCiphertext(body));
      }
    };

    it("exposes required capabilities", async () => {
      useHarness(await createHarness());
      for (const cap of [
        STORAGE_CAPABILITIES.get,
        STORAGE_CAPABILITIES.head,
        STORAGE_CAPABILITIES.put,
        STORAGE_CAPABILITIES.list,
        STORAGE_CAPABILITIES.delete,
        STORAGE_CAPABILITIES.conditionalCreate,
        STORAGE_CAPABILITIES.conditionalReplace,
        STORAGE_CAPABILITIES.strongListAfterWrite,
      ]) {
        assert.ok(adapter.capabilities.has(cap), `missing capability ${cap}`);
      }
      assert.equal(typeof adapter.init, "function");
      assert.equal(typeof adapter.close, "function");
    });

    it("round-trips ciphertext with head/get/list/delete", async () => {
      useHarness(await createHarness());
      await adapter.init();
      const body = sampleEncryptedObjectBytes();
      const ref = await adapter.put("accounts/demo/blobs/a.enc", body);
      assert.equal(ref.key, "accounts/demo/blobs/a.enc");
      assert.ok(ref.etag);
      assert.equal(ref.size, body.length);

      const head = await adapter.head("accounts/demo/blobs/a.enc");
      assert.ok(head);
      assert.equal(head.size, body.length);
      assert.equal(head.etag, ref.etag);

      const got = await adapter.get("accounts/demo/blobs/a.enc");
      assert.ok(got);
      assert.deepEqual(got.body, body);
      assert.equal(got.etag, ref.etag);

      const listed = await adapter.list("accounts/demo/");
      const row = listed.objects.find((entry) => entry.key === ref.key);
      assert.ok(row);
      assert.equal(row.size, body.length);

      await adapter.delete("accounts/demo/blobs/a.enc");
      assert.equal(await adapter.get("accounts/demo/blobs/a.enc"), null);
      assertBackingIsCiphertextOnly();
    });

    it("lists root prefix and paginates with cursor", async () => {
      useHarness(await createHarness());
      await adapter.init();
      for (let i = 0; i < 5; i += 1) {
        await adapter.put(`root/obj-${i}.enc`, sampleEncryptedObjectBytesVariant(i + 1));
      }
      const page1 = await adapter.list("", { limit: 2 });
      assert.equal(page1.objects.length, 2);
      assert.ok(page1.nextCursor);
      const page2 = await adapter.list("", { limit: 2, cursor: page1.nextCursor });
      assert.equal(page2.objects.length, 2);
      assert.notDeepEqual(page2.objects[0]?.key, page1.objects[0]?.key);
      assertBackingIsCiphertextOnly();
    });

    it("enforces ifNoneMatch create-only and ifMatch updates", async () => {
      useHarness(await createHarness());
      await adapter.init();
      const first = sampleEncryptedObjectBytes();
      const second = sampleEncryptedObjectBytesVariant(0xff);

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
        () => adapter.put("manifest.json", first, { ifMatch: head?.etag }),
        (err) => err instanceof PreconditionFailedError,
      );
      assertBackingIsCiphertextOnly();
    });

    it("rejects stale ifMatch for same-length ciphertext payloads", async () => {
      useHarness(await createHarness());
      await adapter.init();
      const a = sampleEncryptedObjectBytes();
      const b = sampleEncryptedObjectBytesVariant(0x0f);

      const created = await adapter.put("same-len/a.enc", a, { ifNoneMatch: "*" });
      await adapter.put("same-len/b.enc", b, { ifNoneMatch: "*" });
      await assert.rejects(
        () => adapter.put("same-len/b.enc", b, { ifMatch: created.etag }),
        (err) => err instanceof PreconditionFailedError,
      );
    });

    it("two-writer CAS: only one ifMatch succeeds", async () => {
      useHarness(await createHarness());
      await adapter.init();
      const initial = sampleEncryptedObjectBytes();
      const ref = await adapter.put("cas/object.enc", initial, { ifNoneMatch: "*" });
      const head = await adapter.head("cas/object.enc");
      assert.ok(head?.etag);

      const writerA = sampleEncryptedObjectBytesVariant(0x01);
      const writerB = sampleEncryptedObjectBytesVariant(0x02);
      const results = await Promise.allSettled([
        adapter.put("cas/object.enc", writerA, { ifMatch: head.etag }),
        adapter.put("cas/object.enc", writerB, { ifMatch: head.etag }),
      ]);
      const fulfilled = results.filter((row) => row.status === "fulfilled");
      const rejected = results.filter((row) => row.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assertBackingIsCiphertextOnly();
    });

    it("delete(ifMatch) fails when object missing", async () => {
      useHarness(await createHarness());
      await adapter.init();
      await assert.rejects(
        () => adapter.delete("missing.enc", { ifMatch: '"ghost"' }),
        (err) => err instanceof PreconditionFailedError,
      );
    });

    it("delete(ifMatch) fails on etag mismatch", async () => {
      useHarness(await createHarness());
      await adapter.init();
      const ref = await adapter.put("del/me.enc", sampleEncryptedObjectBytes(), { ifNoneMatch: "*" });
      await assert.rejects(
        () => adapter.delete("del/me.enc", { ifMatch: '"stale"' }),
        (err) => err instanceof PreconditionFailedError,
      );
      assert.ok(await adapter.get("del/me.enc"));
      await adapter.delete("del/me.enc", { ifMatch: ref.etag });
      assert.equal(await adapter.get("del/me.enc"), null);
    });

    it("rejects plaintext and envelope bypass writes", async () => {
      useHarness(await createHarness());
      await adapter.init();
      const plaintext = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
      await assert.rejects(() => adapter.put("blobs/plain.json", plaintext));
      assert.throws(() => assertStorageCiphertext(plaintext));

      const envelopeBypass = new TextEncoder().encode(
        JSON.stringify({
          ic_storage_v: 1,
          aad: SAMPLE_AAD,
          enc: {
            __ic_enc: 1,
            kid: "dek_v1",
            v: 1,
            alg: "XC20P",
            nonce: SAMPLE_NONCE_B64,
            ct: "AA==",
          },
          title: "plaintext leak",
        }),
      );
      await assert.rejects(() => adapter.put("blobs/bypass.json", envelopeBypass));

      const ascii = new TextEncoder().encode("not encrypted");
      await assert.rejects(() => adapter.put("blobs/x.enc", ascii));
      assert.equal(await adapter.get("blobs/x.enc"), null);
      assertBackingIsCiphertextOnly();
    });
  });
}
