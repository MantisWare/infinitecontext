import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../infinitecontext.mjs");

describe("CLI entry", () => {
  it("runs help without template literal syntax errors", () => {
    const result = spawnSync(process.execPath, [cliPath, "help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /infinitecontext login/);
  });

  it("runs version", () => {
    const result = spawnSync(process.execPath, [cliPath, "version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
  });

  it("runs whoami when not signed in", () => {
    const env = { ...process.env, HOME: `/tmp/ic-cli-${Date.now()}` };
    const result = spawnSync(process.execPath, [cliPath, "whoami"], { encoding: "utf8", env });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Not signed in/i);
  });
});
