#!/usr/bin/env node
/**
 * Embed workspace-only packages into the published infinitecontext tarball.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
const vendorRoot = path.join(sdkRoot, "vendor");

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function patchFile(filePath, replacers) {
  let text = fs.readFileSync(filePath, "utf8");
  for (const [from, to] of replacers) {
    text = text.split(from).join(to);
  }
  fs.writeFileSync(filePath, text);
}

function walkMjs(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMjs(p, fn);
    else if (entry.name.endsWith(".mjs")) fn(p);
  }
}

rimraf(vendorRoot);
copyDir(path.join(repoRoot, "apps/sync/src"), path.join(vendorRoot, "sync"));
copyDir(path.join(repoRoot, "packages/parsers/src"), path.join(vendorRoot, "parsers"));

walkMjs(path.join(vendorRoot, "sync"), (file) => {
  patchFile(file, [
    ["@infinitecontext/parsers", "../parsers/index.mjs"],
    ["./parsers-bundle/index.mjs", "../parsers/index.mjs"],
    ["./parsers-bundle/utils.mjs", "../parsers/utils.mjs"],
  ]);
});

console.log("prepack-vendor: embedded sync + parsers into vendor/");
