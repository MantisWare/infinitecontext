import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.ALLOW_LIB_TEST_ENV === "1") {
  console.log("check-lib-no-test-env: ALLOW_LIB_TEST_ENV=1 — skipping lib/ TEST env guard");
  process.exit(0);
}

/** @type {string[]} */
const patterns = [
  String.raw`process\.env\.\w*TEST\b`,
  String.raw`process\.env\[[^\]]*TEST[^\]]*\]`,
  String.raw`\{\s*[^}]*\b\w*TEST\b[^}]*\}\s*=\s*process\.env`,
];

/** @type {string[]} */
const hits = [];

for (const pattern of patterns) {
  const res = spawnSync("rg", ["-n", pattern, "lib/"], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  if (res.status !== 0 && res.status !== 1) {
    console.error(`check-lib-no-test-env: rg failed (status ${res.status}) for /${pattern}/`);
    process.exit(res.status ?? 2);
  }
  const chunk = String(res.stdout ?? "").trim();
  if (chunk) {
    hits.push(chunk);
  }
}

const aliased = spawnSync(
  "rg",
  ["-n", String.raw`(const|let|var)\s+\w+\s*=\s*process\.env`, "lib/"],
  { cwd: sdkRoot, encoding: "utf8" },
);
if (aliased.status === 0) {
  for (const line of String(aliased.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const file = line.split(":")[0];
    if (!file) continue;
    const follow = spawnSync("rg", ["-n", String.raw`\.\w*TEST\b`, file], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    if (follow.status === 0 && String(follow.stdout ?? "").trim()) {
      hits.push(String(follow.stdout ?? "").trim());
    }
  }
}

const unique = [...new Set(hits.join("\n").split("\n").filter(Boolean))];
if (unique.length > 0) {
  console.error(
    "check-lib-no-test-env: lib/ must not read process.env.*TEST (use *ForTests setters in tests):\n",
  );
  console.error(unique.join("\n"));
  process.exit(1);
}

console.log("check-lib-no-test-env: ok");
