import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(sdkRoot, "tests/storage/fixtures/premerge-mutant-m3-probe.mjs");

describe("S-M3 source regression (shutdown latch)", () => {
  it("latched SIGINT dominates exitPremerge(1) without PREMERGE_MUTANT", async () => {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [probe], {
        cwd: sdkRoot,
        env: { ...process.env, PREMERGE_MUTANT: "", IC_PREMERGE_ALLOW_MUTANT: "" },
        stdio: "ignore",
      });
      child.on("exit", (c) => resolve(c));
    });
    assert.equal(code, 130);
  });
});
