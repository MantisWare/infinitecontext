#!/usr/bin/env node
import { ensureSdkDevVenv, runMypy, runPytest } from "./python-venv.mjs";

if (!ensureSdkDevVenv("check")) {
  process.exit(1);
}

if (runMypy("check") !== 0) {
  process.exit(1);
}

process.exit(runPytest([]));
