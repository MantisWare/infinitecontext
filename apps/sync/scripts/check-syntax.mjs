#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(syncRoot, "src");

/** @type {string[]} */
const entryFiles = [
  "index.mjs",
  "dev.mjs",
  "boot-daemon.mjs",
  "host-auth.mjs",
  "api-key-host-auth.mjs",
  "daemon.mjs",
  "tui.mjs",
  "launcher.mjs",
  "ctl.mjs",
  "env.mjs",
];

function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (name.endsWith(".mjs")) {
      out.push(abs);
    }
  }
  return out;
}

const all = walk(srcRoot).sort();
for (const rel of entryFiles) {
  const abs = path.join(srcRoot, rel);
  if (!fs.existsSync(abs)) {
    console.error(`missing entry file: ${rel}`);
    process.exit(1);
  }
}

for (const abs of all) {
  execSync(`node --check ${JSON.stringify(abs)}`, { stdio: "inherit" });
}
