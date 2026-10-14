import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import {
  FS_GEN_SUFFIX,
  FS_TEMP_PREFIX,
} from "../../lib/storage/filesystem-object-file.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";

describe("filesystem write realpath", () => {
  it("unlinks temp file when realpath rejects an escaping object path", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-write-realpath-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-write-outside-"));
    const key = "escape/write.enc";
    const { keyDir } = objectKeyDirectory(rootDir, key);
    fs.mkdirSync(path.dirname(keyDir), { recursive: true });
    fs.symlinkSync(outside, keyDir);

    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await assert.rejects(
      () => adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" }),
      (error) => error instanceof StorageError && error.code === "invalid_argument",
    );

    const temps = fs.readdirSync(outside).filter((name) => name.includes(FS_TEMP_PREFIX) || name.includes(`${FS_GEN_SUFFIX}.tmp.`));
    assert.equal(temps.length, 0);

    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
