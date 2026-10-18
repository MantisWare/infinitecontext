import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

describe("filesystem adapter symlink escape (citation target)", () => {
  it("rejects symlink escape under the store root", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-storage-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-outside-"));
    fs.mkdirSync(path.join(rootDir, "objects"), { recursive: true });
    fs.symlinkSync(outside, path.join(rootDir, "objects", "escape"));
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await assert.rejects(() => adapter.get("escape/probe"), /symlink|Invalid|Refusing/i);
    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
