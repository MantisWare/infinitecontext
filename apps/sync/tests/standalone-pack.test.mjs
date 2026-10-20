import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { packSyncFromStaging } from "../scripts/pack-from-staging.mjs";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("sync standalone pack", () => {
  it("installs packed sync alone and loads store without infinitecontext", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-pack-out-"));
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-standalone-"));
    try {
      const tgz = packSyncFromStaging({ packDestination: outDir });
      assert.ok(fs.existsSync(tgz));

      fs.writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "ic-sync-smoke", private: true, type: "module" }),
      );
      execSync(`npm install --no-save --ignore-scripts --legacy-peer-deps "file:${tgz}"`, {
        cwd: installDir,
        stdio: "inherit",
      });

      const script = path.join(installDir, "smoke.mjs");
      fs.writeFileSync(
        script,
        `import { resolveDbPath } from '@infinitecontext/sync/store';
if (typeof resolveDbPath !== 'function') process.exit(2);
`,
      );
      execSync(`node ${script}`, { cwd: installDir, stdio: "inherit" });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(installDir, { recursive: true, force: true });
    }
  });
});
