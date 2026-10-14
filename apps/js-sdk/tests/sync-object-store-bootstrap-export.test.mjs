import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("sync-object-store-bootstrap export", () => {
  it("loads configureObjectStoreSyncTransportIfNeeded from package export path", async () => {
    const mod = await import("infinitecontext/lib/sync-object-store-bootstrap.mjs");
    assert.equal(typeof mod.configureObjectStoreSyncTransportIfNeeded, "function");
  });
});
