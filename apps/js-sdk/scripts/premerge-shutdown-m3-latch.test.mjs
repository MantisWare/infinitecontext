import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shutdownSrc = fs.readFileSync(path.join(sdkRoot, "scripts/premerge-shutdown.mjs"), "utf8");
const probe = path.join(sdkRoot, "tests/storage/fixtures/premerge-mutant-m3-probe.mjs");

describe("S-M3 source regression (shutdown latch)", () => {
  it("exitPremerge honors shuttingDown latch in production source", () => {
    assert.match(
      shutdownSrc,
      /function exitPremerge\(code\)\s*\{[\s\S]*if \(shuttingDown && !hasPremergeMutant\("M3"\)\)/,
      "exitPremerge must route latched shutdown to 130, not arbitrary exit codes",
    );
  });

  it("latched SIGINT dominates exitPremerge(1) at runtime", async () => {
    const { spawn } = await import("node:child_process");
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
