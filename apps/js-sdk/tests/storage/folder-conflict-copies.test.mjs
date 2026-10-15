import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalizeConflictStorageKey,
  conflictSegmentToCanonical,
} from "../../lib/storage/folder-conflict-copies.mjs";

describe("folder conflict copy names", () => {
  it("detects iCloud duplicate suffix", () => {
    assert.equal(conflictSegmentToCanonical("000000000001 2.enc"), "000000000001.enc");
    assert.equal(
      canonicalizeConflictStorageKey("accounts/x/ic-v1/log/abc/000000000001 2.enc"),
      "accounts/x/ic-v1/log/abc/000000000001.enc",
    );
  });

  it("detects Dropbox conflicted copy", () => {
    assert.equal(
      conflictSegmentToCanonical("manifest.json (conflicted copy).enc"),
      "manifest.json.enc",
    );
  });

  it("canonicalizes Dropbox-style segment names", () => {
    assert.equal(
      canonicalizeConflictStorageKey("accounts/local/ic-v1/manifest.json (conflicted copy).enc"),
      "accounts/local/ic-v1/manifest.json.enc",
    );
  });
});
