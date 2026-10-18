import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(syncRoot, "../..");

function syncGitPorcelain() {
  const out = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
  if (!out) return [];
  return out
    .split("\n")
    .filter(
      (line) =>
        line.includes("apps/sync/package.json") ||
        line.includes("apps/sync/.package.prepack.json"),
    )
    .sort();
}

describe("sync pack staging", () => {
  it("does not dirty tracked package.json after injected pack failure", () => {
    const before = syncGitPorcelain();
    try {
      execSync("node scripts/pack-from-staging.mjs --inject-failure", {
        cwd: syncRoot,
        stdio: "pipe",
        env: { ...process.env, NODE_OPTIONS: "" },
      });
      assert.fail("expected pack to fail");
    } catch {
      // expected
    }
    const after = syncGitPorcelain();
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(syncRoot, ".package.prepack.json")), false);
  });

  it("packs from staging without changing sync package.json git state", () => {
    const before = syncGitPorcelain();
    const tgz = execSync("node scripts/pack-from-staging.mjs", {
      cwd: syncRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    }).trim();
    assert.ok(fs.existsSync(tgz));
    try {
      fs.rmSync(tgz, { force: true });
    } catch {}
    const after = syncGitPorcelain();
    assert.deepEqual(after, before);
  });
});
