import assert from "node:assert/strict";

import { assertStorageCiphertext, buildStorageObjectBytes, scanStorageObjectForLeaks } from "./ciphertext.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import { STORAGE_CAPABILITIES } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

const SAMPLE_NONCE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_CT_B64 = Buffer.alloc(16, 0).toString("base64");

/** @param {string} objectKey */
export function sampleEncryptedObjectBytesForKey(objectKey) {
  return buildStorageObjectBytes(objectKey, {
    __ic_enc: 1,
    kid: "dek_v1",
    v: 1,
    alg: "XC20P",
    nonce: SAMPLE_NONCE_B64,
    ct: VALID_CT_B64,
  });
}

/** @param {string} objectKey @param {number} tagByte */
function sampleEncryptedObjectBytesVariant(objectKey, tagByte) {
  const ct = Buffer.alloc(16, tagByte).toString("base64");
  return buildStorageObjectBytes(objectKey, {
    __ic_enc: 1,
    kid: "dek_v1",
    v: 1,
    alg: "XC20P",
    nonce: SAMPLE_NONCE_B64,
    ct,
  });
}

/**
 * @typedef {Object} StorageBackingSnapshot
 * @property {string[]} keys
 * @property {Uint8Array[]} bodies
 * @property {Record<string, unknown>[]} metadata
 */

/**
 * @typedef {Object} StorageAdapterTestHarness
 * @property {StorageAdapter} adapter
 * @property {() => StorageBackingSnapshot} inspectBacking
 */

/**
 * @param {() => StorageAdapterTestHarness | Promise<StorageAdapterTestHarness>} createHarness
 * @param {{ describe: Function, it: Function }} test
 */
export function runStorageAdapterContractSuite(createHarness, { describe, it }) {
  describe("StorageAdapter contract", () => {
    /** @type {StorageAdapter} */
    let adapter;
    /** @type {(() => StorageBackingSnapshot) | undefined} */
    let inspectBacking;

    /** @param {StorageAdapterTestHarness} harness */
    const useHarness = (harness) => {
      adapter = harness.adapter;
      inspectBacking = harness.inspectBacking;
    };

    const requireInspectBacking = () => {
      assert.equal(typeof inspectBacking, "function", "contract suite requires inspectBacking harness");
    };

    const assertBackingIsCiphertextOnly = () => {
      requireInspectBacking();
      const { keys, bodies, metadata } = inspectBacking();
      assert.ok(Array.isArray(keys));
      assert.ok(Array.isArray(bodies));
      assert.ok(Array.isArray(metadata));
      for (let i = 0; i < bodies.length; i += 1) {
        const key = keys[i] ?? `idx-${i}`;
        const body = bodies[i];
        assert.doesNotThrow(() => assertStorageCiphertext(body, { objectKey: key }));
        assert.doesNotThrow(() => scanStorageObjectForLeaks(key, body));
        const meta = metadata[i];
        if (meta && typeof meta === "object") {
          assert.ok(meta.aad, "stored metadata must retain aad");
          assert.ok(meta.enc, "stored metadata must retain enc");
        }
      }
    };

    it("requires inspectBacking harness", async () => {
      const harness = await createHarness();
      useHarness(harness);
      requireInspectBacking();
    });

    it("exposes required capabilities", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
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
      requireInspectBacking();
      await adapter.init();
      const key = "accounts/demo/blobs/a.enc";
      const body = sampleEncryptedObjectBytesForKey(key);
      const ref = await adapter.put(key, body);
      assert.equal(ref.key, key);
      assert.ok(ref.etag);
      assert.equal(ref.size, body.length);

      const head = await adapter.head(key);
      assert.ok(head);
      assert.equal(head.size, body.length);
      assert.equal(head.etag, ref.etag);

      const got = await adapter.get(key);
      assert.ok(got);
      assert.deepEqual(got.body, body);
      assert.equal(got.etag, ref.etag);

      const listed = await adapter.list("accounts/demo/");
      const row = listed.objects.find((entry) => entry.key === ref.key);
      assert.ok(row);
      assert.equal(row.size, body.length);

      await adapter.delete(key);
      assert.equal(await adapter.get(key), null);
      assertBackingIsCiphertextOnly();
    });

    it("lists root prefix and paginates with cursor", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
      await adapter.init();
      for (let i = 0; i < 5; i += 1) {
        const key = `root/obj-${i}.enc`;
        await adapter.put(key, sampleEncryptedObjectBytesVariant(key, i + 1));
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
      requireInspectBacking();
      await adapter.init();
      const key = "manifest.json";
      const first = sampleEncryptedObjectBytesForKey(key);
      const second = sampleEncryptedObjectBytesVariant(key, 0xff);

      await adapter.put(key, first, { ifNoneMatch: "*" });
      await assert.rejects(
        () => adapter.put(key, second, { ifNoneMatch: "*" }),
        (err) => err instanceof PreconditionFailedError,
      );

      const head = await adapter.head(key);
      await adapter.put(key, second, { ifMatch: head?.etag });
      const got = await adapter.get(key);
      assert.deepEqual(got?.body, second);

      await assert.rejects(
        () => adapter.put(key, first, { ifMatch: head?.etag }),
        (err) => err instanceof PreconditionFailedError,
      );
      assertBackingIsCiphertextOnly();
    });

    it("rejects stale ifMatch across distinct objects", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
      await adapter.init();
      const keyA = "same-len/a.enc";
      const keyB = "same-len/b.enc";
      const created = await adapter.put(keyA, sampleEncryptedObjectBytesForKey(keyA), { ifNoneMatch: "*" });
      const b = sampleEncryptedObjectBytesVariant(keyB, 0x0f);
      await adapter.put(keyB, b, { ifNoneMatch: "*" });
      await assert.rejects(
        () => adapter.put(keyB, b, { ifMatch: created.etag }),
        (err) => err instanceof PreconditionFailedError,
      );
    });

    it("two-writer CAS: only one ifMatch succeeds", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
      await adapter.init();
      const key = "cas/object.enc";
      const initial = sampleEncryptedObjectBytesForKey(key);
      const head = await adapter.head(key);
      assert.equal(head, null);
      await adapter.put(key, initial, { ifNoneMatch: "*" });
      const afterCreate = await adapter.head(key);
      assert.ok(afterCreate?.etag);

      const writerA = sampleEncryptedObjectBytesVariant(key, 0x01);
      const writerB = sampleEncryptedObjectBytesVariant(key, 0x02);
      const results = await Promise.allSettled([
        adapter.put(key, writerA, { ifMatch: afterCreate.etag }),
        adapter.put(key, writerB, { ifMatch: afterCreate.etag }),
      ]);
      const fulfilled = results.filter((row) => row.status === "fulfilled");
      const rejected = results.filter((row) => row.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assertBackingIsCiphertextOnly();
    });

    it("delete(ifMatch) fails when object missing", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
      await adapter.init();
      await assert.rejects(
        () => adapter.delete("missing.enc", { ifMatch: '"ghost"' }),
        (err) => err instanceof PreconditionFailedError,
      );
    });

    it("delete(ifMatch) fails on etag mismatch", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
      await adapter.init();
      const key = "del/me.enc";
      const ref = await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
      await assert.rejects(
        () => adapter.delete(key, { ifMatch: '"stale"' }),
        (err) => err instanceof PreconditionFailedError,
      );
      assert.ok(await adapter.get(key));
      await adapter.delete(key, { ifMatch: ref.etag });
      assert.equal(await adapter.get(key), null);
    });

    it("rejects plaintext and envelope bypass writes", async () => {
      useHarness(await createHarness());
      requireInspectBacking();
      await adapter.init();
      const plaintext = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
      await assert.rejects(() => adapter.put("blobs/plain.json", plaintext));
      assert.throws(() => assertStorageCiphertext(plaintext));

      const key = "blobs/bypass.json";
      const envelopeBypass = new TextEncoder().encode(
        JSON.stringify({
          ic_storage_v: 1,
          aad: "ic-storage|blobs|0000000000000000|0",
          enc: {
            __ic_enc: 1,
            kid: "dek_v1",
            v: 1,
            alg: "XC20P",
            nonce: SAMPLE_NONCE_B64,
            ct: VALID_CT_B64,
          },
          title: "plaintext leak",
        }),
      );
      await assert.rejects(() => adapter.put(key, envelopeBypass));

      const ascii = new TextEncoder().encode("not encrypted");
      await assert.rejects(() => adapter.put("blobs/x.enc", ascii));
      assert.equal(await adapter.get("blobs/x.enc"), null);
      assertBackingIsCiphertextOnly();
    });

  });
}
