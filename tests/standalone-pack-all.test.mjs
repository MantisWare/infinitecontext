/**
 * CI-style: each publishable package must install alone from its packed tarball.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ dir: string, name: string, smoke: (installDir: string) => void }[]} */
const PUBLISHABLE = [
  {
    dir: "apps/js-sdk",
    name: "infinitecontext",
    smoke(installDir) {
      execSync(`node node_modules/infinitecontext/infinitecontext.mjs version`, {
        cwd: installDir,
        stdio: "inherit",
      });
    },
  },
  {
    dir: "apps/mcp-server",
    name: "infinitecontext-mcp-server",
    smoke(installDir) {
      const help = execSync(`node node_modules/infinitecontext-mcp-server/dist/stdio.js --help`, {
        cwd: installDir,
        encoding: "utf8",
      });
      assert.match(help, /Usage/i);
    },
  },
];

function packPackage(dir) {
  const abs = path.join(repoRoot, dir);
  if (dir === "apps/js-sdk") {
    execSync("pnpm run prepack", { cwd: abs, stdio: "inherit" });
  } else if (dir === "apps/mcp-server") {
    execSync("pnpm run prepack", { cwd: abs, stdio: "inherit" });
  }
  const out = execSync("pnpm pack --silent", { cwd: abs, encoding: "utf8" }).trim().split("\n").pop();
  return path.join(abs, out);
}

describe("standalone pack install (publishable packages)", () => {
  for (const pkg of PUBLISHABLE) {
    it(`${pkg.name} installs alone from pnpm pack tarball`, () => {
      const tgz = packPackage(pkg.dir);
      assert.ok(fs.existsSync(tgz), tgz);

      const installDir = fs.mkdtempSync(path.join(os.tmpdir(), `ic-standalone-${pkg.name}-`));
      fs.writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: `${pkg.name}-smoke`, private: true, type: "module" }),
      );
      execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps "file:${tgz}"`, {
        cwd: installDir,
        stdio: "inherit",
      });
      pkg.smoke(installDir);
    });
  }
});
