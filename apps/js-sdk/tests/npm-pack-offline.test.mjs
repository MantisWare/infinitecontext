import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");

function packWorkspacePackage(dir) {
  const packOutput = execSync("pnpm pack --silent", { cwd: dir, encoding: "utf8" }).trim();
  const name = packOutput.split("\n").pop();
  return path.join(dir, name);
}

describe("npm pack offline install", () => {
  it("packs tarball without @infinitecontext/crypto dependency and loads ic-crypto", () => {
    execSync("pnpm run build", { cwd: sdkRoot, stdio: "inherit" });
    const coreTgz = packWorkspacePackage(path.join(repoRoot, "packages/core"));
    const parsersTgz = packWorkspacePackage(path.join(repoRoot, "packages/parsers"));
    const syncTgz = packWorkspacePackage(path.join(repoRoot, "apps/sync"));
    const tgz = packWorkspacePackage(sdkRoot);
    assert.ok(fs.existsSync(tgz));

    const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
    assert.equal(pkg.dependencies?.["@infinitecontext/crypto"], undefined);

    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pack-"));
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "ic-pack-smoke", private: true, type: "module" }),
    );
    const files = [coreTgz, parsersTgz, syncTgz, tgz].map((f) => `"file:${f}"`).join(" ");
    execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps ${files}`, {
      cwd: installDir,
      stdio: "inherit",
    });
    const installedRoot = path.join(installDir, "node_modules", "infinitecontext");
    assert.ok(fs.existsSync(path.join(installedRoot, "lib/ic-crypto.mjs")));
    assert.ok(fs.existsSync(path.join(installedRoot, "lib/vault-agent-serve.mjs")));
    assert.ok(fs.existsSync(path.join(installedRoot, "lib/vault-agent.mjs")));
    const scriptPath = path.join(installDir, "smoke.mjs");
    fs.writeFileSync(
      scriptPath,
      `import { isEncryptedContent } from './node_modules/infinitecontext/lib/ic-crypto.mjs';
if (!isEncryptedContent({ __ic_enc: 1, kid: 'dek_v1', v: 1, alg: 'XC20P', nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', ct: 'AA==' })) process.exit(2);
`,
    );
    execSync(`node ${scriptPath}`, { cwd: installDir, stdio: "inherit" });
  });
});
