#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = path.join(sdkRoot, ".venv");
const venvPython = path.join(venvDir, "bin", "python");
const venvMypy = path.join(venvDir, "bin", "mypy");
const pyprojectPath = path.join(sdkRoot, "pyproject.toml");
const installStampPath = path.join(venvDir, ".infinitecontext-dev-deps.sha256");

const REQUIRED_PYTHON = "3.8";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: sdkRoot, encoding: "utf8", stdio: "inherit", ...opts });
  return res.status ?? 1;
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { cwd: sdkRoot, encoding: "utf8" });
}

function pyprojectHash() {
  return createHash("sha256").update(fs.readFileSync(pyprojectPath)).digest("hex");
}

function venvPythonMinor() {
  if (!fs.existsSync(venvPython)) {
    return null;
  }
  const res = runCapture(venvPython, [
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
  ]);
  if (res.status !== 0) {
    return null;
  }
  return res.stdout.trim();
}

function removeVenv() {
  if (fs.existsSync(venvDir)) {
    fs.rmSync(venvDir, { recursive: true, force: true });
  }
}

function ensurePython38Venv() {
  const current = venvPythonMinor();
  if (current === REQUIRED_PYTHON) {
    return true;
  }

  if (current !== null) {
    removeVenv();
  }

  const res = runCapture("uv", ["venv", "--python", REQUIRED_PYTHON, venvDir]);
  if (res.status === 0 && fs.existsSync(venvPython) && venvPythonMinor() === REQUIRED_PYTHON) {
    return true;
  }

  removeVenv();
  console.error(
    "python-sdk: check failed — Python 3.8 is required for mypy (httpx must stay fully typed).",
  );
  console.error("Install Python 3.8 for uv, then retry (e.g. `uv python install 3.8`).");
  if (res.stderr) {
    process.stderr.write(res.stderr);
  }
  return false;
}

function ensureDevDeps() {
  const hash = pyprojectHash();
  if (fs.existsSync(installStampPath)) {
    const stamp = fs.readFileSync(installStampPath, "utf8").trim();
    if (stamp === hash) {
      return true;
    }
  }

  const status = run("uv", ["pip", "install", "--python", venvPython, "-e", ".[dev]", "-q"]);
  if (status !== 0) {
    removeVenv();
    return false;
  }

  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(installStampPath, hash);
  return true;
}

if (!ensurePython38Venv()) {
  process.exit(1);
}

if (!ensureDevDeps()) {
  process.exit(1);
}

if (run(venvMypy, []) !== 0) {
  process.exit(1);
}

process.exit(run(venvPython, ["-m", "pytest", "-q"]));
