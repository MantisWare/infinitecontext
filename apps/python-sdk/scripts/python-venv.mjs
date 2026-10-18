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

function fail(label, message, hint) {
  console.error(`python-sdk: ${label} failed — ${message}`);
  if (hint) {
    console.error(hint);
  }
}

function assertUvAvailable(label) {
  const res = spawnSync("uv", ["--version"], { encoding: "utf8" });
  if (res.error?.code === "ENOENT") {
    fail(
      label,
      "`uv` not found on PATH.",
      "Install uv (https://docs.astral.sh/uv/) and ensure it is on PATH.",
    );
    return false;
  }
  if (res.status !== 0) {
    fail(label, "could not run `uv --version`.", res.stderr?.trim() ?? undefined);
    return false;
  }
  return true;
}

function createPython38Venv(label) {
  const res = runCapture("uv", ["venv", "--python", REQUIRED_PYTHON, venvDir]);
  if (res.status === 0 && fs.existsSync(venvPython) && venvPythonMinor() === REQUIRED_PYTHON) {
    return true;
  }

  removeVenv();
  fail(
    label,
    "Python 3.8 is required for the SDK dev venv (mypy targets 3.8 with fully typed httpx).",
    "Install Python 3.8 for uv, then retry (e.g. `uv python install 3.8`).",
  );
  if (res.stderr) {
    process.stderr.write(res.stderr);
  }
  return false;
}

function venvNeedsRecreate(label) {
  if (!fs.existsSync(venvDir)) {
    return true;
  }
  const minor = venvPythonMinor();
  if (minor !== REQUIRED_PYTHON) {
    console.error(
      `python-sdk: ${label} — replacing .venv (expected Python ${REQUIRED_PYTHON}, found ${minor ?? "broken interpreter"}).`,
    );
    removeVenv();
    return true;
  }
  return false;
}

function stampMatches() {
  if (!fs.existsSync(installStampPath)) {
    return false;
  }
  return fs.readFileSync(installStampPath, "utf8").trim() === pyprojectHash();
}

function venvToolsHealthy() {
  if (!fs.existsSync(venvMypy)) {
    return false;
  }
  const mypyRun = runCapture(venvMypy, ["--version"]);
  if (mypyRun.status !== 0) {
    return false;
  }
  const imports = runCapture(venvPython, ["-c", "import httpx, pytest"]);
  return imports.status === 0;
}

/**
 * Shared Python 3.8 `.venv` for check and test (uv + uv pip).
 * @param {string} label - "check" | "test"
 */
export function ensureSdkDevVenv(label) {
  if (!assertUvAvailable(label)) {
    return false;
  }

  const minor = venvPythonMinor();
  const hashChanged = fs.existsSync(installStampPath) && !stampMatches();
  const toolsBroken = fs.existsSync(venvDir) && stampMatches() && !venvToolsHealthy();

  if (hashChanged) {
    console.error(`python-sdk: ${label} — pyproject.toml changed; recreating .venv.`);
    removeVenv();
  } else if (fs.existsSync(venvDir) && minor !== REQUIRED_PYTHON) {
    venvNeedsRecreate(label);
  } else if (toolsBroken) {
    console.error(
      `python-sdk: ${label} — .venv is incomplete or broken (missing mypy, pytest, or httpx); recreating.`,
    );
    removeVenv();
  }

  if (!fs.existsSync(venvDir)) {
    if (!createPython38Venv(label)) {
      return false;
    }
  }

  if (stampMatches() && venvToolsHealthy()) {
    return true;
  }

  const installStatus = spawnSync(
    "uv",
    ["pip", "install", "--python", venvPython, "-e", ".[dev]", "-q"],
    { cwd: sdkRoot, encoding: "utf8", stdio: "inherit" },
  ).status;
  if (installStatus !== 0) {
    fail(label, "could not install editable package with dev extras.", undefined);
    removeVenv();
    return false;
  }

  if (!venvToolsHealthy()) {
    fail(
      label,
      "dev venv is missing tools after install (expected mypy, pytest, httpx).",
      "Delete apps/python-sdk/.venv and retry.",
    );
    removeVenv();
    return false;
  }

  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(installStampPath, pyprojectHash());
  return true;
}

export function runMypy(label) {
  if (!fs.existsSync(venvMypy)) {
    fail(label, "mypy is not installed in .venv.", "Run `npm run check` to recreate the dev venv.");
    return 1;
  }
  const res = spawnSync(venvMypy, [], { cwd: sdkRoot, encoding: "utf8", stdio: "inherit" });
  if (res.error?.code === "ENOENT") {
    fail(label, "mypy is not installed in .venv.", "Run `npm run check` to recreate the dev venv.");
    return 1;
  }
  return res.status ?? 1;
}

export function runPytest(extraArgs) {
  const res = spawnSync(venvPython, ["-m", "pytest", "-q", ...extraArgs], {
    cwd: sdkRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (res.error?.code === "ENOENT") {
    fail("test", ".venv Python is missing or broken.", "Delete apps/python-sdk/.venv and retry.");
    return 1;
  }
  return res.status ?? 1;
}

export { sdkRoot, venvDir, venvPython, venvMypy };
