#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = path.join(sdkRoot, ".venv");
const venvPython = path.join(venvDir, "bin", "python");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: sdkRoot, encoding: "utf8", stdio: "inherit", ...opts });
  return res.status ?? 1;
}

function tryCreateVenv() {
  if (fs.existsSync(venvPython)) return true;
  const status = run("python3", ["-m", "venv", venvDir], { stdio: "pipe" });
  if (status === 0 && fs.existsSync(venvPython)) return true;
  console.log(
    "python-sdk: skipping tests (could not create .venv — install python3-venv or create apps/python-sdk/.venv manually).",
  );
  return false;
}

if (!tryCreateVenv()) {
  process.exit(0);
}

if (run(venvPython, ["-m", "pip", "install", "-e", ".[dev]", "-q"]) !== 0) {
  process.exit(1);
}
process.exit(run(venvPython, ["-m", "pytest", "-q", ...process.argv.slice(2)]));
