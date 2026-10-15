import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  parseConflictAwareGenerationFileName,
  readConflictAwareGenerationHighWater,
} from "../../lib/storage/folder-conflict-files.mjs";
import { FS_GEN_HIGH_WATER_BASENAME } from "../../lib/storage/filesystem-object-file.mjs";
import { loadLatestObjectGenerationAtDir } from "../../lib/storage/filesystem-generations.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";

describe("folder conflict generation files", () => {
  it("parses iCloud duplicate generation filenames", () => {
    assert.equal(parseConflictAwareGenerationFileName("000000000002.icgen"), 2);
    assert.equal(parseConflictAwareGenerationFileName("000000000002 2.icgen"), 2);
  });

  it("merges high-water conflict copies by max", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-hw-"));
    fs.writeFileSync(path.join(dir, FS_GEN_HIGH_WATER_BASENAME), JSON.stringify({ high_water: 3 }));
    fs.writeFileSync(
      path.join(dir, `${FS_GEN_HIGH_WATER_BASENAME} 2`),
      JSON.stringify({ high_water: 5 }),
    );
    assert.equal(readConflictAwareGenerationHighWater(dir), 5);
  });

  it("reads object through duplicate generation file copies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-gen-dup-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 100 });
    const key = "accounts/demo/blob.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    return (async () => {
      await adapter.init();
      await adapter.put(key, body, { ifNoneMatch: "*" });
      const { keyDir } = objectKeyDirectory(root, key);
      const canonicalGen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen") && !n.includes(" "));
      assert.ok(canonicalGen);
      fs.copyFileSync(
        path.join(keyDir, canonicalGen),
        path.join(keyDir, canonicalGen.replace(".icgen", " 2.icgen")),
      );
      const got = await adapter.get(key);
      assert.ok(got);
      assert.deepEqual(got.body, body);
    })();
  });
});
