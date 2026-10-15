import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { gcLogSegmentsCoveredByCompaction } from "../../lib/storage/storage-compaction.mjs";
import { loadStorageManifest } from "../../lib/storage/storage-manifest.mjs";

const DEK = new Uint8Array(32).fill(5);
const PREFIX = "accounts/gc-off";

describe("folder GC policy", () => {
  it("never deletes log segments on folder backend", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-gc-"));
    const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 100 });
    await adapter.init();
    const ctx = {
      adapter,
      dek: DEK,
      layoutPrefix: PREFIX,
      selfDevH: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
      deviceUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      localState: createInMemoryObjectStoreLocalState(),
    };
    const manifest = await loadStorageManifest(adapter, DEK, PREFIX);
    const result = await gcLogSegmentsCoveredByCompaction(ctx, manifest);
    assert.equal(result.deleted, 0);
    assert.equal(result.gcDisabled, true);
  });
});
