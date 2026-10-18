#!/usr/bin/env node
import { ensureSdkDevVenv, runPytest } from "./python-venv.mjs";

if (!ensureSdkDevVenv("test")) {
  process.exit(1);
}

process.exit(runPytest(process.argv.slice(2)));
