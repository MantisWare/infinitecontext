import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveObjectStoreSyncBindingKey } from "../../lib/object-store-sync-binding.mjs";

describe("binding key from effective rootDir option", () => {
  it("uses rootDir override instead of config path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-bind-root-"));
    const cfg = {
      storage: { backend: "folder", folder: { path: "/tmp/other-folder" } },
    };
    const fromConfig = resolveObjectStoreSyncBindingKey(cfg);
    const fromOption = resolveObjectStoreSyncBindingKey(cfg, process.env, {
      rootDir: root,
      backendId: "folder",
    });
    assert.notEqual(fromConfig, fromOption);
    assert.ok(fromOption.endsWith(path.resolve(root)));
  });
});
