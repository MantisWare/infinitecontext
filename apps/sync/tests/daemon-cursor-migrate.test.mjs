import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store.mjs";

describe("daemon pull cursor migration", () => {
  it("imports legacy sync-state.json cursor into sync:pull_cursor", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ic-daemon-migrate-"));
    const dbPath = path.join(home, "daemon.db");
    fs.writeFileSync(
      path.join(home, "sync-state.json"),
      `${JSON.stringify({ cursor: 42, outbox: [], parked_failures: [] })}\n`,
    );

    const store = createStore({ dbPath });
    assert.equal(store.getSyncPullCursor(), 42);
    store.close();
  });
});
