import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  FOLDER_HONEST_CAPABILITIES,
  createFolderStorageAdapter,
} from "../../lib/storage/folder-adapter.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";
import {
  runStorageAdapterContractSuite,
  sampleEncryptedObjectBytesForKey,
} from "../../lib/storage/contract-suite.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { icloudPlaceholderSiblingPath } from "../../lib/storage/folder-icloud-placeholder.mjs";

runStorageAdapterContractSuite(
  async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-storage-"));
    const adapter = createFolderStorageAdapter({ rootDir, exposeInternalsForTests: true });
    return {
      adapter,
      inspectBacking: () => {
        const snap = adapter.exposeInternalsForTests?.();
        assert.ok(snap);
        return snap;
      },
    };
  },
  { describe, it },
  {
    requiredCapabilities: [...FOLDER_HONEST_CAPABILITIES],
    skipConditionalReplaceTests: true,
    skipConditionalDeleteIfMatchTests: true,
  },
);

describe("folder storage adapter", () => {
  it("rejects ifMatch put without conditionalReplace capability", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-cap-"));
    const adapter = createFolderStorageAdapter({ rootDir, placeholderTimeoutMs: 100 });
    await adapter.init();
    const key = "probe/ifmatch.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(
      () => adapter.put(key, body, { ifMatch: '"stale"' }),
      (err) => err instanceof StorageError && err.code === "not_supported",
    );
  });

  it("lists conflict-copy keys under canonical names", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-list-"));
    const adapter = createFolderStorageAdapter({ rootDir, placeholderTimeoutMs: 100 });
    await adapter.init();
    const canonical = "accounts/demo/ic-v1/log/abc/000000000001.enc";
    const body = sampleEncryptedObjectBytesForKey(canonical);
    await adapter.inner.put(canonical, body, { ifNoneMatch: "*" });
    const { keyDir } = objectKeyDirectory(rootDir, canonical);
    const parent = path.dirname(keyDir);
    const conflictDir = path.join(parent, "000000000001 2.enc");
    fs.cpSync(keyDir, conflictDir, { recursive: true });
    const listed = await adapter.list("accounts/demo/ic-v1/log/abc/");
    assert.equal(listed.objects.length, 1);
    assert.equal(listed.objects[0]?.key, canonical);
  });

  it("throws evicted_placeholder instead of returning null for iCloud stubs", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-icloud-"));
    const adapter = createFolderStorageAdapter({ rootDir, placeholderTimeoutMs: 300 });
    await adapter.init();
    const key = "accounts/demo/ic-v1/log/abc/000000000002.enc";
    const { keyDir } = objectKeyDirectory(rootDir, key);
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const target = path.join(keyDir, "000000000000001.icgen");
    fs.writeFileSync(target, "", { mode: 0o600 });
    fs.writeFileSync(icloudPlaceholderSiblingPath(target), "stub", { mode: 0o600 });
    await assert.rejects(
      () => adapter.get(key),
      (err) => err instanceof StorageError && err.code === "evicted_placeholder",
    );
  });

  it("does not advertise cross-device CAS capabilities", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-honest-"));
    const adapter = createFolderStorageAdapter({ rootDir });
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace), false);
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.strongListAfterWrite), false);
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalCreate), true);
  });
});
