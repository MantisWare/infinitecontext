import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StorageError } from "../../lib/storage/errors.mjs";
import { assertCanonicalStorageObjectKey } from "../../lib/storage/filesystem-keys.mjs";

describe("filesystem storage key grammar", () => {
  it("accepts canonical keys", () => {
    assert.equal(assertCanonicalStorageObjectKey("accounts/demo/blobs/a.enc"), "accounts/demo/blobs/a.enc");
  });

  it("rejects traversal and dot segments", () => {
    for (const key of ["../x", "a/../b", "a/./b", ".hidden", "a/.b"]) {
      assert.throws(() => assertCanonicalStorageObjectKey(key), StorageError);
    }
  });

  it("rejects slashes and reserved temp prefixes", () => {
    assert.throws(() => assertCanonicalStorageObjectKey("/leading"), StorageError);
    assert.throws(() => assertCanonicalStorageObjectKey("trailing/"), StorageError);
    assert.throws(() => assertCanonicalStorageObjectKey(".ic-fs-tmp.leak"), StorageError);
    assert.throws(() => assertCanonicalStorageObjectKey("storage-objects.lock"), StorageError);
  });
});
