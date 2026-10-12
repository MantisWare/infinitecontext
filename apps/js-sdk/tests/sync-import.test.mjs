import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { importSync, missingSyncPackage } from "../lib/sync-import.mjs";

describe("sync-import", () => {
  it("only vendor-fallbacks when @infinitecontext/sync itself is missing", () => {
    assert.equal(
      missingSyncPackage(
        { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package '@infinitecontext/sync/store'" },
        "store",
      ),
      true,
    );
    assert.equal(
      missingSyncPackage(
        { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package '@infinitecontext/parsers'" },
        "sync",
      ),
      false,
    );
  });

  it("loads store from workspace sync in the monorepo", async () => {
    const mod = await importSync("store");
    assert.equal(typeof mod.resolveDbPath, "function");
  });
});
