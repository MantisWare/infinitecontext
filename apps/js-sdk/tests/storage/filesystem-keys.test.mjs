import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StorageError } from "../../lib/storage/errors.mjs";
import {
  assertCanonicalStorageObjectKey,
  keyMatchesListPrefix,
  normalizeListPrefix,
} from "../../lib/storage/filesystem-keys.mjs";

describe("filesystem storage key grammar", () => {
  it("accepts lowercase canonical keys", () => {
    assert.equal(assertCanonicalStorageObjectKey("accounts/demo/blobs/a.enc"), "accounts/demo/blobs/a.enc");
  });

  it("rejects uppercase letters", () => {
    assert.throws(() => assertCanonicalStorageObjectKey("Accounts/demo"), StorageError);
  });

  it("rejects traversal, dot segments, and trailing dots", () => {
    for (const key of ["../x", "a/../b", "a/./b", ".hidden", "a/.b", "trail."]) {
      assert.throws(() => assertCanonicalStorageObjectKey(key), StorageError);
    }
  });

  it("rejects windows reserved device names", () => {
    assert.throws(() => assertCanonicalStorageObjectKey("com1/file.enc"), StorageError);
  });

  it("list prefix trailing slash boundary", () => {
    const prefix = normalizeListPrefix("a/");
    assert.equal(keyMatchesListPrefix("a/y.enc", prefix), true);
    assert.equal(keyMatchesListPrefix("ab/x.enc", prefix), false);
  });
});
