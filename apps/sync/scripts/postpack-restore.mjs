#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(syncRoot, "package.json");
const backupPath = path.join(syncRoot, ".package.prepack.json");

if (!fs.existsSync(backupPath)) {
  process.exit(0);
}

fs.copyFileSync(backupPath, pkgPath);
fs.rmSync(backupPath, { force: true });
console.log("sync postpack-restore: restored package.json after pack");
