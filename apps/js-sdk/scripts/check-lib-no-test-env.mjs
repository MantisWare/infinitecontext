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
  String.raw`process\.env\.[A-Z0-9_]*TEST[A-Z0-9_]*`,
  String.raw`process\.env\[[^\]]*TEST[^\]]*\]`,
  String.raw`process\.env\s*\[`,
  String.raw`\{\s*env\s*\}\s*=\s*process`,
  String.raw`\bIC_TESTING\b`,
  String.raw`\{\s*[^}]*\b[A-Z0-9_]*TEST[A-Z0-9_]*\b[^}]*\}\s*=\s*process\.env`,
  String.raw`Reflect\.get\s*\(\s*process\.env`,
  String.raw`Reflect\.get\s*\(\s*\w+\.env`,
  String.raw`process\.env\.[a-z0-9_]*test[a-z0-9_]*`,
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
    const follow = spawnSync("rg", ["-n", String.raw`\.[A-Za-z0-9_]*TEST[A-Za-z0-9_]*\b`, file], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    if (follow.status === 0 && String(follow.stdout ?? "").trim()) {
      hits.push(String(follow.stdout ?? "").trim());
    }
  }
}

const envDestructure = spawnSync(
  "rg",
  ["-n", String.raw`(const|let|var)\s*\{\s*env\s*\}\s*=\s*process`, "lib/"],
  { cwd: sdkRoot, encoding: "utf8" },
);
if (envDestructure.status === 0) {
  for (const line of String(envDestructure.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const file = line.split(":")[0];
    if (!file) continue;
    const follow = spawnSync("rg", ["-n", String.raw`env\.[A-Za-z0-9_]*TEST[A-Za-z0-9_]*`, file], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    if (follow.status === 0 && String(follow.stdout ?? "").trim()) {
      hits.push(String(follow.stdout ?? "").trim());
    }
  }
}

const nodeProcessImport = spawnSync(
  "rg",
  ["-n", String.raw`from\s+["']node:process["']`, "lib/"],
  { cwd: sdkRoot, encoding: "utf8" },
);
if (nodeProcessImport.status === 0) {
  for (const line of String(nodeProcessImport.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(":");
    const file = parts[0];
    if (!file) continue;
    const importLine = line.slice(line.indexOf(":") + 1);
    const aliasMatch = importLine.match(
      /import\s+\{([^}]+)\}\s+from\s+["']node:process["']/,
    );
    const defaultMatch = importLine.match(/import\s+(\w+)\s+from\s+["']node:process["']/);
    /** @type {string[]} */
    const bindings = [];
    if (aliasMatch) {
      for (const part of aliasMatch[1].split(",")) {
        const trimmed = part.trim();
        const name = trimmed.split(/\s+as\s+/)[0]?.trim();
        if (name) bindings.push(name);
      }
    }
    if (defaultMatch) {
      bindings.push(defaultMatch[1]);
    }
    for (const binding of bindings) {
      const follow = spawnSync(
        "rg",
        ["-n", String.raw`${binding}\.env\.[A-Za-z0-9_]*TEST[A-Za-z0-9_]*`, file],
        { cwd: sdkRoot, encoding: "utf8" },
      );
      if (follow.status === 0 && String(follow.stdout ?? "").trim()) {
        hits.push(String(follow.stdout ?? "").trim());
      }
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
