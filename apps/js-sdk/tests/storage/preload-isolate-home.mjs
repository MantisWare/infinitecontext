import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "../../../../scripts/ic-test-tmp-preload.mjs";

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-test-home-"));
process.env.HOME = isolatedHome;
if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === "") {
  process.env.NODE_ENV = "test";
}

function cleanupIsolatedHome() {
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

process.once("exit", cleanupIsolatedHome);
process.once("SIGINT", () => {
  cleanupIsolatedHome();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanupIsolatedHome();
  process.exit(143);
});
