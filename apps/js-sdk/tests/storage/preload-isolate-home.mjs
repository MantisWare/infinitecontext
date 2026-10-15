import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-test-home-"));
process.env.HOME = isolatedHome;

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
