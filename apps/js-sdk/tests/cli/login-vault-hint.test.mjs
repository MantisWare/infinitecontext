import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const loginPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/cli/login.mjs");

describe("login vault gate", () => {
  it("skips interactive vault when password-stdin and prints a hint", () => {
    const src = readFileSync(loginPath, "utf8");
    assert.match(src, /skipInteractiveVault/);
    assert.match(src, /passwordStdin/);
    assert.match(src, /infinitecontext vault init/);
  });
});
