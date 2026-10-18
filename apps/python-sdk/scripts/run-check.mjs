#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = path.join(sdkRoot, ".venv");
const venvPython = path.join(venvDir, "bin", "python");
const venvPip = path.join(venvDir, "bin", "pip");
const venvMypy = path.join(venvDir, "bin", "mypy");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: sdkRoot, encoding: "utf8", stdio: "inherit", ...opts });
  return res.status ?? 1;
}

function removePartialVenv() {
  if (!fs.existsSync(venvDir)) return;
  if (fs.existsSync(venvPip)) return;
  fs.rmSync(venvDir, { recursive: true, force: true });
}

function tryCreateVenv() {
  removePartialVenv();
  if (fs.existsSync(venvPip)) return true;
  const status = run("python3", ["-m", "venv", venvDir], { stdio: "pipe" });
  if (status === 0 && fs.existsSync(venvPip)) return true;
  removePartialVenv();
  console.error(
    "python-sdk: check failed (could not create .venv — install python3-venv or create apps/python-sdk/.venv manually).",
  );
  return false;
}

if (!tryCreateVenv()) {
  process.exit(1);
}

if (run(venvPython, ["-m", "pip", "install", "-e", ".[dev]", "-q"]) !== 0) {
  removePartialVenv();
  process.exit(1);
}

if (run(venvMypy, []) !== 0) {
  process.exit(1);
}

process.exit(run(venvPython, ["-m", "pytest", "-q"]));
