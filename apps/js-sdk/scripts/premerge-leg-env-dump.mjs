#!/usr/bin/env node
import fs from "node:fs";

const outPath = process.argv[2];
if (!outPath) {
  process.exit(2);
}
const keys = [
  "PREMERGE_MUTANT",
  "IC_PREMERGE_ALLOW_MUTANT",
  "PREMERGE_TEST_B1_SIGINT_OFFSET_MS",
  "PREMERGE_TEST_B1_SIGINT_DELAY_MS",
  "PREMERGE_TEST_REVERT_B1",
];
/** @type {Record<string, string | undefined>} */
const slice = {};
for (const key of keys) {
  slice[key] = process.env[key];
}
fs.writeFileSync(outPath, JSON.stringify(slice));
