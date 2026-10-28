import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(sdkRoot, "tests/storage/fixtures/premerge-b1-offset-probe.mjs");

/**
 * @param {number} offsetMs
 * @param {Record<string, string>} extraEnv
 */
function runOffsetOnce(offsetMs, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture], {
      cwd: sdkRoot,
      env: {
        ...process.env,
        PREMERGE_TEST_B1_SIGINT_OFFSET_MS: String(offsetMs),
        ...extraEnv,
      },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function offsetRange(full) {
  if (full) {
    /** @type {number[]} */
    const out = [];
    for (let o = -60; o <= 450; o += 5) {
      out.push(o);
    }
    return out;
  }
  /** Default gate: cover early positive offsets where reverted B1 exits 1 (+5…+120). */
  /** @type {number[]} */
  const sample = [-60, 0, 5];
  for (let o = 15; o <= 120; o += 15) {
    sample.push(o);
  }
  sample.push(200, 450);
  return [...new Set(sample)].sort((a, b) => a - b);
}

describe("B1 leg fail vs SIGINT offset probe (300 ms leg exit)", () => {
  const full = String(process.env.IC_PREMERGE_B1_PROBE_FULL ?? "").trim() === "1";
  const reps = full ? 10 : 3;

  it("head: exit 130 for probe offsets (reps each)", async () => {
    for (const offset of offsetRange(full)) {
      for (let rep = 0; rep < reps; rep += 1) {
        const code = await runOffsetOnce(offset);
        assert.equal(code, 130, `offset=${offset} rep=${rep + 1}`);
      }
    }
  }, 600_000);

  it("reverted B1 hunk: exit 1 for positive probe offsets (reps each)", async () => {
    const positive = offsetRange(full).filter((o) => o >= 5);
    for (const offset of positive) {
      for (let rep = 0; rep < reps; rep += 1) {
        const code = await runOffsetOnce(offset, {
          PREMERGE_MUTANT: "B1",
          IC_PREMERGE_ALLOW_MUTANT: "1",
        });
        assert.equal(code, 1, `offset=${offset} rep=${rep + 1}`);
      }
    }
  }, 600_000);
});
