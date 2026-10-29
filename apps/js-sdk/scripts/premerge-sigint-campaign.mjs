#!/usr/bin/env node
/**
 * Serial SIGINT campaign against real premerge.mjs (45 runs).
 * Does NOT prune or remove Docker resources — leftover ic_premerge_* after a run is a product bug.
 *
 * Usage (ubuntu + sg docker, from repo root):
 *   export IC_SIGINT_OUTSIDE_VAULT_MARKER=/path/to/marker.txt  # optional
 *   node apps/js-sdk/scripts/premerge-sigint-campaign.mjs
 *
 * Output: TSV path in PREMERGE_SIGINT_TSV (default /tmp/premerge-sigint-final.tsv)
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPostgresPassword, runPremergeSigintOnce } from "./premerge-sigint-lib.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
delete process.env.IC_PREMERGE_SIGINT_RACE_TIMEOUT_MS;
delete process.env.IC_PREMERGE_SIGINT_TEST_HARNESS;
// Default lib wrap is `sg docker -c` (Tester VM). Campaign uses direct docker when unset/empty.
if (!String(process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP ?? "").trim()) {
  process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP = "";
}
const head = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
const password = loadPostgresPassword(repoRoot);
const tsvPath = process.env.PREMERGE_SIGINT_TSV ?? "/tmp/premerge-sigint-final.tsv";
const outsideVaultMarker = String(process.env.IC_SIGINT_OUTSIDE_VAULT_MARKER ?? "").trim() || undefined;

/** @type {[string, string, RegExp, Record<string, string>?][]} */
const runs = [];
for (let i = 1; i <= 4; i += 1) {
  runs.push(["early", `guard-${i}`, /guard:12|check-12-paths/, {}]);
}
for (let i = 1; i <= 3; i += 1) {
  runs.push([
    "early",
    `pnpm-${i}`,
    /premerge: starting pnpm -r check|Scope: [0-9]+ of/,
    {},
  ]);
}
for (let i = 1; i <= 3; i += 1) {
  runs.push(["early", `fetch-${i}`, /check-12-paths/, {}]);
}
const jsSdkLegPattern =
  /premerge: starting pnpm -r test|Scope: [0-9]+ of [0-9]+ workspace projects|> infinitecontext@[^ ]+ test/;
for (let i = 1; i <= 30; i += 1) {
  runs.push(["js-sdk-leg", `js-${String(i).padStart(2, "0")}`, jsSdkLegPattern, {}]);
}
for (let i = 1; i <= 5; i += 1) {
  runs.push([
    "fail-cleanup",
    `gate-${i}`,
    /SYNTHETIC|premerge package test coverage failed/,
    {
      IC_PREMERGE_SKIP_LEGS: "1",
      IC_PREMERGE_ALLOW_SKIP_LEGS: "1",
      IC_PREMERGE_ALLOW_DIRTY: "1",
      IC_PREMERGE_PROBE: "floor-violation",
    },
  ]);
}

fs.writeFileSync(
  tsvPath,
  "category\tlabel\trc\ttmpLeft\thit\tpremergePid\tpremergeAlive\tdockerBefore\tdockerAfter\tvaultBefore\tvaultAfter\tmarkerOk\n",
);

/**
 * @param {string} category
 * @param {string} label
 * @param {RegExp} pattern
 * @param {Record<string, string> | undefined} extra
 */
async function runCampaignTrial(category, label, pattern, extra) {
  const maxAttempts = category === "js-sdk-leg" ? 3 : 1;
  /** @type {Awaited<ReturnType<typeof runPremergeSigintOnce>> | null} */
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await runPremergeSigintOnce({
      category,
      label,
      pattern,
      head,
      password,
      extraEnv: extra ?? {},
      outsideVaultMarker,
    });
    if (last.ok) {
      return last;
    }
    const retryEarlyExit =
      category === "js-sdk-leg" && last.hit === 0 && last.code === 1 && attempt < maxAttempts;
    if (retryEarlyExit) {
      console.error(
        `SIGINT campaign retry ${label} attempt ${attempt}/${maxAttempts} (hit=0 rc=1 before readiness)`,
      );
      continue;
    }
    return last;
  }
  return last;
}

let fail = 0;
for (const [category, label, pattern, extra] of runs) {
  // eslint-disable-next-line no-await-in-loop
  const row = await runCampaignTrial(category, label, pattern, extra);
  const line = `${category}\t${label}\trc=${row.code}\ttmpLeft=${row.tmpLeft}\thit=${row.hit}\tpremergePid=${row.premergePid ?? ""}\tpremergeAlive=${row.premergeAlive}\tdockerBefore=${row.dockerBefore.count}\tdockerAfter=${row.dockerAfter.count}\tvaultBefore=${row.vaultBefore}\tvaultAfter=${row.vaultAfter}\tmarkerOk=${row.markerOk}\n`;
  fs.appendFileSync(tsvPath, line);
  console.log(line.trim(), row.ok ? "OK" : "FAIL");
  if (!row.ok) {
    fail += 1;
  }
}

console.log(`SIGINT campaign head=${head} fail=${fail}/${runs.length} tsv=${tsvPath}`);
process.exit(fail > 0 ? 1 : 0);
