import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { packSyncFromStaging } from "../scripts/pack-from-staging.mjs";

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
    assert.throws(() => packSyncFromStaging({ injectFailure: true }), /injected pack failure/);
    const after = syncGitPorcelain();
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(syncRoot, ".package.prepack.json")), false);
  });

  it("packs from staging without changing sync package.json git state", () => {
    const before = syncGitPorcelain();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-pack-out-"));
    try {
      const tgz = packSyncFromStaging({ packDestination: outDir });
      assert.ok(fs.existsSync(tgz));
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    const after = syncGitPorcelain();
    assert.deepEqual(after, before);
  });
});
