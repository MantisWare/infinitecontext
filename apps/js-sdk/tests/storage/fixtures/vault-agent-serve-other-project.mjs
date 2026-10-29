#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const real = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../lib/vault-agent-serve.mjs");
const child = spawn(process.execPath, [real], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();
