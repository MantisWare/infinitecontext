import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(mcpRoot, "../..");
const sdkRoot = path.join(repoRoot, "apps/js-sdk");

function packWorkspacePackage(dir) {
  const packOutput = execSync("pnpm pack --silent", { cwd: dir, encoding: "utf8" }).trim();
  const name = packOutput.split("\n").pop();
  return path.join(dir, name);
}

describe("mcp-server npm pack bin", () => {
  it("builds dist/stdio.js and runs packaged bin with a clean auth message", () => {
    execSync("pnpm run build", { cwd: sdkRoot, stdio: "inherit" });
    execSync("pnpm run build", { cwd: mcpRoot, stdio: "inherit" });
    assert.ok(fs.existsSync(path.join(mcpRoot, "dist", "stdio.js")));

    const coreTgz = packWorkspacePackage(path.join(repoRoot, "packages/core"));
    const parsersTgz = packWorkspacePackage(path.join(repoRoot, "packages/parsers"));
    const syncTgz = packWorkspacePackage(path.join(repoRoot, "apps/sync"));
    const sdkTgz = packWorkspacePackage(sdkRoot);
    const mcpTgz = packWorkspacePackage(mcpRoot);

    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mcp-pack-"));
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "ic-mcp-pack-smoke", private: true, type: "module" }),
    );
    const files = [coreTgz, parsersTgz, syncTgz, sdkTgz, mcpTgz].map((f) => `"file:${f}"`).join(" ");
    execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps ${files}`, {
      cwd: installDir,
      stdio: "inherit",
    });

    const binPath = path.join(installDir, "node_modules", "infinitecontext-mcp-server", "dist", "stdio.js");
    assert.ok(fs.existsSync(binPath));

    let stderr = "";
    try {
      execSync(`node "${binPath}"`, {
        cwd: installDir,
        encoding: "utf8",
        env: { ...process.env, HOME: installDir },
      });
    } catch (error) {
      stderr = String(error.stderr ?? error.stdout ?? "");
      assert.notEqual(error.status, 0);
    }
    assert.match(stderr, /Authentication required|infinitecontext login/i);
    assert.doesNotMatch(stderr, /^\s*at /m);
  });
});
