import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/entry.mjs");

describe("sync parked CLI routing", () => {
  it("entry.mjs routes sync parked to sync-cli", () => {
    const src = fs.readFileSync(entryPath, "utf8");
    assert.match(
      src,
      /subcommand === "pull"[\s\S]*subcommand === "parked"/,
      "expected parked alongside pull/push/devices in sync subcommand router",
    );
  });
});
