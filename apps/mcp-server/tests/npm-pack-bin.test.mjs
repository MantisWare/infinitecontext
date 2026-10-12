import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("mcp-server npm pack bin", () => {
  it("installs packed tarball alone and runs infinitecontext-mcp --help", () => {
    execSync("pnpm run prepack", { cwd: mcpRoot, stdio: "inherit" });
    const packOutput = execSync("pnpm pack --silent", { cwd: mcpRoot, encoding: "utf8" }).trim();
    const tgz = path.join(mcpRoot, packOutput.split("\n").pop());
    assert.ok(fs.existsSync(tgz));

    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mcp-standalone-"));
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "ic-mcp-smoke", private: true, type: "module" }),
    );
    execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps "file:${tgz}"`, {
      cwd: installDir,
      stdio: "inherit",
    });

    const binPath = path.join(installDir, "node_modules", ".bin", "infinitecontext-mcp");
    assert.ok(fs.existsSync(binPath));

    const help = execSync(`"${binPath}" --help`, {
      cwd: installDir,
      encoding: "utf8",
      env: { ...process.env, HOME: installDir },
    });
    assert.match(help, /Usage/i);
    assert.match(help, /infinitecontext-mcp/i);

    const stdioJs = path.join(installDir, "node_modules", "infinitecontext-mcp-server", "dist", "stdio.js");
    assert.ok(fs.existsSync(stdioJs));
    const head = fs.readFileSync(stdioJs, "utf8").slice(0, 30);
    assert.match(head, /^#!\/usr\/bin\/env node/);
  });
});
