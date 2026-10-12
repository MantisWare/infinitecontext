import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("npm pack offline install", () => {
  it("installs the packed CLI alone without workspace tarballs", () => {
    execSync("pnpm run prepack", { cwd: sdkRoot, stdio: "inherit" });
    const packOutput = execSync("pnpm pack --silent", { cwd: sdkRoot, encoding: "utf8" }).trim();
    const tgz = path.join(sdkRoot, packOutput.split("\n").pop());
    assert.ok(fs.existsSync(tgz));
    assert.ok(fs.existsSync(path.join(sdkRoot, "vendor", "sync", "daemon.mjs")));

    const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
    assert.equal(pkg.dependencies?.["@infinitecontext/core"], undefined);
    assert.equal(pkg.dependencies?.["@infinitecontext/sync"], undefined);
    assert.equal(pkg.dependencies?.["@infinitecontext/crypto"], undefined);

    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-pack-standalone-"));
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "ic-pack-smoke", private: true, type: "module" }),
    );
    execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps "file:${tgz}"`, {
      cwd: installDir,
      stdio: "inherit",
    });
    const installedRoot = path.join(installDir, "node_modules", "infinitecontext");
    assert.ok(fs.existsSync(path.join(installedRoot, "lib/ic-crypto.mjs")));
    assert.ok(fs.existsSync(path.join(installedRoot, "vendor/sync/daemon.mjs")));
    const scriptPath = path.join(installDir, "smoke.mjs");
    fs.writeFileSync(
      scriptPath,
      `import { isEncryptedContent } from './node_modules/infinitecontext/lib/ic-crypto.mjs';
if (!isEncryptedContent({ __ic_enc: 1, kid: 'dek_v1', v: 1, alg: 'XC20P', nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', ct: 'AA==' })) process.exit(2);
import { HOSTED_API_BASE_URL } from './node_modules/infinitecontext/lib/client-config.mjs';
if (!HOSTED_API_BASE_URL) process.exit(3);
`,
    );
    execSync(`node ${scriptPath}`, { cwd: installDir, stdio: "inherit" });
    execSync(`node ${path.join(installDir, "node_modules/infinitecontext/infinitecontext.mjs")} version`, {
      cwd: installDir,
      stdio: "inherit",
    });
  });
});
