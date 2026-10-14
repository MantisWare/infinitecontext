import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import {
  formatObjectGenerationFileName,
  listGenerationPathsForKeyDir,
  objectKeyDirectory,
} from "../../lib/storage/filesystem-generations.mjs";

describe("filesystem generation prune", () => {
  it("drops pre-tombstone generations on delete commit", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-prune-delete-"));
    const key = "prune/delete-me.enc";
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    await adapter.delete(key);

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const gens = listGenerationPathsForKeyDir(keyDir);
    assert.equal(gens.length, 1);
    assert.equal(gens[0].gen, 2);

    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("removes tombstone generations below the retention floor on later live commits", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-prune-tomb-"));
    const key = "prune/tombstone-floor.enc";
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.delete(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.put(key, body, { ifMatch: (await adapter.get(key))?.etag });

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const gens = listGenerationPathsForKeyDir(keyDir);
    const genNums = gens.map((row) => row.gen).sort((a, b) => a - b);
    assert.deepEqual(genNums, [3, 4]);
    assert.equal(
      fs.existsSync(path.join(keyDir, formatObjectGenerationFileName(2))),
      false,
    );

    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
