#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parsersSrc = path.resolve(syncRoot, "../../packages/parsers/src");
const dest = path.join(syncRoot, "src", "parsers-bundle");
const pkgPath = path.join(syncRoot, "package.json");
const backupPath = path.join(syncRoot, ".package.prepack.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, JSON.stringify(pkg, null, 2) + "\n");
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(parsersSrc, dest, { recursive: true });

pkg.imports = {
  "#parsers": "./src/parsers-bundle/index.mjs",
  "#parsers/utils": "./src/parsers-bundle/utils.mjs",
};
delete pkg.dependencies["@infinitecontext/parsers"];

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("sync prepack-vendor: embedded parsers-bundle and rewrote package imports for pack");
