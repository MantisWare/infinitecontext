#!/usr/bin/env node
/**
 * Run node --test with glob patterns without shell globstar (patterns stay literal for Node/fs).
 * Usage: node run-node-test.mjs [--import path]... -- 'glob' ['glob'...]
 */
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";

/** @type {string[]} */
const imports = [];
/** @type {string[]} */
const patterns = [];
const argv = process.argv.slice(2);
let i = 0;
for (; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--") {
    i += 1;
    break;
  }
  if (arg === "--import" && i + 1 < argv.length) {
    imports.push(argv[i + 1]);
    i += 1;
    continue;
  }
  console.error(`run-node-test: unexpected argument ${arg} (use --import path and -- patterns)`);
  process.exit(1);
}
for (; i < argv.length; i += 1) {
  patterns.push(argv[i]);
}

if (patterns.length === 0) {
  console.error("run-node-test: pass at least one glob pattern after --");
  process.exit(1);
}

const cwd = process.cwd();
/** @type {string[]} */
const files = [];
for (const pattern of patterns) {
  for (const match of globSync(pattern, { cwd })) {
    files.push(path.resolve(cwd, match));
  }
}

const unique = [...new Set(files)].sort();
if (unique.length === 0) {
  console.error(`run-node-test: no files matched patterns: ${patterns.join(" ")}`);
  process.exit(1);
}

/** @type {string[]} */
const nodeArgs = ["--test", "--test-concurrency=1"];
for (const imp of imports) {
  nodeArgs.push("--import", imp);
}
nodeArgs.push(...unique);

const res = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", cwd });
process.exit(res.status ?? 1);
