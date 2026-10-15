import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { StorageError } from "../../lib/storage/errors.mjs";
import {
  createFolderObjectStore,
  resolveFolderObjectStoreRootDir,
} from "../../lib/storage/folder-object-store.mjs";

describe("folder object store wiring", () => {
  it("requires storage.folder.path", () => {
    assert.throws(
      () => resolveFolderObjectStoreRootDir({ storage: { backend: "folder" } }),
      (err) => err instanceof StorageError && err.code === "invalid_argument",
    );
  });

  it("opens folder backend under configured path", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-folder-root-"));
    const store = await createFolderObjectStore({
      rootDir,
      config: { storage: { backend: "folder", folder: { path: rootDir } } },
    });
    assert.equal(store.adapter.id, "folder");
    await store.close();
  });
});
