import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(sdkRoot, "tests/storage/fixtures/premerge-b1-leg-fail-race.mjs");

/**
 * @param {Record<string, string>} extraEnv
 */
function runOnce(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture], {
      cwd: sdkRoot,
      env: {
        ...process.env,
        IC_PREMERGE_ALLOW_MUTANT: "1",
        ...extraEnv,
      },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

describe("B1 pnpm-check leg fail vs SIGINT (deterministic ordering)", () => {
  it("head: 20/20 exit 130 when drainPendingSigint is enabled", async () => {
    for (let i = 0; i < 20; i += 1) {
      const code = await runOnce({ PREMERGE_MUTANT: "" });
      assert.equal(code, 130, `run ${i + 1}`);
    }
  });

  it("reverted B1 hunk: 20/20 exit 1 when drainPendingSigint is skipped", async () => {
    for (let i = 0; i < 20; i += 1) {
      const code = await runOnce({
        IC_PREMERGE_FIXTURE_SIMULATE_B1_REVERT: "1",
        PREMERGE_TEST_B1_SIGINT_DELAY_MS: "5000",
      });
      assert.equal(code, 1, `run ${i + 1}`);
    }
  });
});
