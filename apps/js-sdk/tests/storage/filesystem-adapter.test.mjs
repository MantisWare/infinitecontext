import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  runStorageAdapterContractSuite,
  sampleEncryptedObjectBytesForKey,
} from "../../lib/storage/contract-suite.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

runStorageAdapterContractSuite(
  async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-storage-"));
    const adapter = createFilesystemStorageAdapter({ rootDir, exposeInternalsForTests: true });
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
);

describe("filesystem storage adapter", () => {
  it("persists ciphertext across adapter re-open", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-storage-reopen-"));
    const key = "persist/obj.enc";
    const body = sampleEncryptedObjectBytesForKey(key);

    const writer = createFilesystemStorageAdapter({ rootDir });
    await writer.init();
    await writer.put(key, body, { ifNoneMatch: "*" });
    await writer.close();

    const reader = createFilesystemStorageAdapter({ rootDir });
    await reader.init();
    const got = await reader.get(key);
    assert.deepEqual(got?.body, body);
    await reader.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
