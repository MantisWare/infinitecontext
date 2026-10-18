import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.ALLOW_LIB_TEST_ENV === "1") {
  console.log("check-lib-no-test-env: ALLOW_LIB_TEST_ENV=1 — skipping lib/ TEST env guard");
  process.exit(0);
}

const res = spawnSync("rg", ["process\\.env\\.[^\\s]*TEST", "lib/"], {
  cwd: sdkRoot,
  encoding: "utf8",
});

const matches = String(res.stdout ?? "").trim();
if (matches) {
  console.error("check-lib-no-test-env: lib/ must not read process.env.*TEST (use *ForTests setters in tests):\n");
  console.error(matches);
  process.exit(1);
}

if (res.status !== 0 && res.status !== 1) {
  console.error(`check-lib-no-test-env: rg failed (status ${res.status})`);
  process.exit(res.status ?? 2);
}

console.log("check-lib-no-test-env: ok");
