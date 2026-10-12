#!/usr/bin/env node

// bin wrapper — resolves bundled CLI entry from dist/
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// try bundled dist first, fall back to src for dev
const candidates = [
  path.join(__dirname, "dist", "cli", "entry.js"),
  path.join(__dirname, "dist", "cli", "entry.mjs"),
  path.join(__dirname, "src", "cli", "entry.mjs"),
];

let loaded = false;
let lastError;
for (const candidate of candidates) {
  if (!fs.existsSync(candidate)) continue;
  try {
    await import(`file://${candidate}`);
    loaded = true;
    break;
  } catch (error) {
    lastError = error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ERR_MODULE_NOT_FOUND") continue;
    console.error(`infinitecontext: failed to load CLI from ${candidate}`);
    throw error;
  }
}

if (!loaded) {
  if (lastError) {
    console.error(`infinitecontext: could not load CLI entry (${lastError.message ?? lastError}). Run \`pnpm run build\` first.`);
  } else {
    console.error("infinitecontext: could not locate CLI entry. Run `pnpm run build` first.");
  }
  process.exit(1);
}
