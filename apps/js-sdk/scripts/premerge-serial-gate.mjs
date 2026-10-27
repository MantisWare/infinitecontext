#!/usr/bin/env node
/**
 * Serial full premerge gate (no-pty, pty, optional depth-1) + orphan/docker inventory.
 * Usage: node scripts/premerge-serial-gate.mjs [no-pty|pty|d1-pty|all]
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { infinitecontextMinPassFloor } from "./premerge-lib.mjs";
import { icPremergeDockerInventory } from "./premerge-sigint-lib.mjs";
import { loadPostgresPassword } from "./premerge-sigint-lib.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
const head = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
const password = loadPostgresPassword(repoRoot);
const gateRoot = process.env.PREMERGE_GATE_LOG_DIR ?? path.join(os.tmpdir(), `ic-premerge-gate-${head.slice(0, 8)}`);
fs.mkdirSync(gateRoot, { recursive: true });

/** @param {string} mode */
function orphanPatterns() {
  return [
    "ic-orphan-fd-hold",
    "vault-agent-serve.mjs",
    "ic-resume-late-",
    "zz-ic-late-writer",
    "premerge-m6-cwd-holder",
  ];
}

function countOrphans() {
  /** @type {string[]} */
  const lines = [];
  try {
    lines.push(
      ...execSync("ps -eo pid=,args=", { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    return { count: 0, samples: [] };
  }
  const patterns = orphanPatterns();
  /** @type {string[]} */
  const hits = [];
  for (const line of lines) {
    if (patterns.some((p) => line.includes(p))) {
      hits.push(line.trim());
    }
  }
  return { count: hits.length, samples: hits.slice(0, 8) };
}

/**
 * @param {string} mode
 */
function runPremergeOnce(mode) {
  const logPath = path.join(gateRoot, `premerge-${mode}.log`);
  /** @type {Record<string, string>} */
  const extra = {
    EXPECTED_SHA: head,
    POSTGRES_PASSWORD: password,
    PREMERGE_MUTANT: "",
  };
  if (mode === "no-pty") {
    extra.IC_PREMERGE_FORCE_NO_PTY = "1";
  }
  if (mode.startsWith("d1")) {
    extra.IC_PREMERGE_ALLOW_DIRTY = "1";
  }

  const envExport = Object.entries(extra)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");

  let cwd = sdkRoot;
  if (mode.startsWith("d1")) {
    const d1Root = path.join(gateRoot, "d1-clone");
    if (!fs.existsSync(path.join(d1Root, ".git"))) {
      fs.rmSync(d1Root, { recursive: true, force: true });
      execSync(`git clone --depth 1 file://${repoRoot} ${JSON.stringify(d1Root)}`, {
        stdio: "inherit",
      });
      execSync(`git checkout ${head}`, { cwd: d1Root, stdio: "inherit" });
      execSync("pnpm install", { cwd: d1Root, stdio: "inherit", env: process.env });
    }
    cwd = path.join(d1Root, "apps/js-sdk");
  }

  const inner = `cd ${JSON.stringify(cwd)} && ${envExport} node scripts/premerge.mjs`;
  const dockerWrap = String(process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP ?? "sg docker -c").trim();
  const cmd = dockerWrap ? `${dockerWrap} ${JSON.stringify(inner)}` : inner;

  const orphansBefore = countOrphans();
  const dockerBefore = icPremergeDockerInventory();
  const started = Date.now();
  const res = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = Date.now() - started;
  const combined = `${res.stdout}\n${res.stderr}`;
  fs.writeFileSync(logPath, combined);
  const orphansAfter = countOrphans();
  const dockerAfter = icPremergeDockerInventory();

  const summaryMatch = /premerge summary:([\s\S]*?)(?:\n\n|\n$|$)/.exec(combined);
  const icMatch =
    /infinitecontext: pass (\d+), fail (\d+), skipped (\d+), tests (\d+)/.exec(combined) ??
    /infinitecontext: pass (\d+), fail (\d+), skipped (\d+), tests (\d+)/.exec(
      fs.readFileSync(logPath, "utf8"),
    );
  const totalsMatch = /pass: (\d+)[\s\S]*?fail: (\d+)[\s\S]*?skipped: (\d+)[\s\S]*?tests: (\d+)/.exec(
    summaryMatch?.[0] ?? combined,
  );

  const nodePty = !extra.IC_PREMERGE_FORCE_NO_PTY;
  const icFloor = infinitecontextMinPassFloor(nodePty);
  const icPass = icMatch ? Number(icMatch[1]) : -1;
  const makeRc = res.status ?? 1;

  const row = {
    mode,
    makeRc,
    elapsedMs: elapsed,
    icPass,
    icFloor,
    icOk: makeRc === 0 && icPass === icFloor,
    orphansBefore: orphansBefore.count,
    orphansAfter: orphansAfter.count,
    dockerBefore: dockerBefore.count,
    dockerAfter: dockerAfter.count,
    logPath,
  };
  fs.writeFileSync(path.join(gateRoot, `premerge-${mode}.json`), JSON.stringify(row, null, 2));
  console.log(JSON.stringify(row));
  if (orphansAfter.samples.length) {
    console.error("orphan samples:", orphansAfter.samples.join("\n"));
  }
  return row;
}

const arg = process.argv[2] ?? "all";
/** @type {string[]} */
const modes =
  arg === "all" ? ["no-pty", "pty", "d1-pty"] : [arg];

let fail = 0;
for (const mode of modes) {
  const row = runPremergeOnce(mode);
  if (!row.icOk || row.orphansAfter > 0 || row.dockerAfter > 0 || row.makeRc !== 0) {
    fail += 1;
  }
}

if (arg === "all" || process.argv[2] === "sigint") {
  delete process.env.IC_SIGINT_OUTSIDE_VAULT_MARKER;
  const sig = spawnSync(process.execPath, ["scripts/premerge-sigint-campaign.mjs"], {
    cwd: sdkRoot,
    encoding: "utf8",
    env: { ...process.env, IC_SIGINT_OUTSIDE_VAULT_MARKER: "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(gateRoot, "sigint-campaign.log"), `${sig.stdout}\n${sig.stderr}`);
  const m = /fail=(\d+)\/(\d+)/.exec(`${sig.stdout}\n${sig.stderr}`);
  const sigFail = m ? Number(m[1]) : 1;
  const sigTotal = m ? Number(m[2]) : 45;
  fs.writeFileSync(
    path.join(gateRoot, "sigint-campaign.json"),
    JSON.stringify({ fail: sigFail, total: sigTotal, status: sig.status }, null, 2),
  );
  console.log(JSON.stringify({ sigintFail: sigFail, sigintTotal: sigTotal, status: sig.status }));
  if (sigFail > 0 || sig.status !== 0) {
    fail += 1;
  }
}

process.exit(fail > 0 ? 1 : 0);
