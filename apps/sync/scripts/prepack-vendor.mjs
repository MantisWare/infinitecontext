#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parsersSrc = path.resolve(syncRoot, "../../packages/parsers/src");
const dest = path.join(syncRoot, "src", "parsers-bundle");

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(parsersSrc, dest, { recursive: true });
console.log("sync prepack-vendor: copied parsers into src/parsers-bundle/");
