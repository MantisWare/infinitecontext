import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createStore } from "../src/store.mjs";

describe("hosted sync pull cursor", () => {
  it("returns numeric zero on a fresh daemon.db", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-cursor-")), "daemon.db");
    const store = createStore({ dbPath });
    assert.equal(store.getSyncPullCursor(), 0);
  });
});
