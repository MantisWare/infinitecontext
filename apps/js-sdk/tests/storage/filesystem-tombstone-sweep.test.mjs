import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import {
  formatObjectGenerationFileName,
  listAllObjectKeys,
  loadLatestObjectGeneration,
  objectKeyDirectory,
  setFilesystemTombstoneSweepMaxAgeMsForTests,
  sweepStaleTombstoneOnlyKeys,
} from "../../lib/storage/filesystem-generations.mjs";

describe("filesystem tombstone age sweep", () => {
  it("removes tombstone-only keys older than the retention age on init", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-sweep-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);

    const key = "sweep/old-delete.enc";
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    await adapter.delete(key);
    await adapter.close();

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const latest = loadLatestObjectGeneration(rootDir, key);
    assert.ok(latest?.header.tombstone);
    const tombPath = path.join(keyDir, formatObjectGenerationFileName(latest.gen));
    const stale = new Date(Date.now() - 5_000);
    fs.utimesSync(tombPath, stale, stale);

    const reopened = createFilesystemStorageAdapter({ rootDir });
    await reopened.init();
    assert.deepEqual(listAllObjectKeys(rootDir), []);
    assert.equal(fs.existsSync(keyDir), false);
    await reopened.close();

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("does not sweep tombstones when a newer live generation exists", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-sweep-live-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);

    const key = "sweep/recreated.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.delete(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.close();

    sweepStaleTombstoneOnlyKeys(rootDir);
    assert.ok(listAllObjectKeys(rootDir).includes(key));

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
