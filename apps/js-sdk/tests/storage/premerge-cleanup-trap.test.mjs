import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trapChild = path.join(sdkRoot, "tests/storage/fixtures/premerge-trap-child.mjs");

describe("premerge-style cleanup traps", () => {
  it("runs cleanup on SIGINT (exit 130)", async () => {
    const marker = path.join(os.tmpdir(), `ic-premerge-trap-${Date.now()}.txt`);
    const child = spawn(process.execPath, [trapChild], {
      env: { ...process.env, PREMERGE_TRAP_MARKER: marker },
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGINT");
    const code = await new Promise((resolve) => {
      child.on("exit", (status) => resolve(status));
    });
    assert.equal(code, 130);
    assert.equal(fs.readFileSync(marker, "utf8"), "down\n");
    fs.unlinkSync(marker);
  });

  it("runs cleanup on SIGTERM (exit 143)", async () => {
    const marker = path.join(os.tmpdir(), `ic-premerge-trap-term-${Date.now()}.txt`);
    const child = spawn(process.execPath, [trapChild], {
      env: { ...process.env, PREMERGE_TRAP_MARKER: marker },
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => {
      child.on("exit", (status) => resolve(status));
    });
    assert.equal(code, 143);
    assert.equal(fs.readFileSync(marker, "utf8"), "down\n");
    fs.unlinkSync(marker);
  });
});
