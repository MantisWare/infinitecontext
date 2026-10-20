import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

import { listIcPremergeDockerResources } from "./premerge-ephemeral-postgres.mjs";

/**
 * @param {string} log
 * @returns {number | null}
 */
export function parsePremergeNodePidFromLog(log) {
  const m = /premerge: node pid=(\d+)/.exec(log);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} log
 * @returns {string | undefined}
 */
export function parsePremergeTmpDirFromLog(log) {
  const m = /premerge: private TMPDIR=(\S+)/.exec(log);
  return m?.[1];
}

/**
 * @param {number} pid
 */
export function assertPremergeNodePid(pid) {
  const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  if (!cmd.includes("premerge.mjs")) {
    throw new Error(`pid ${pid} is not premerge.mjs (${cmd.slice(0, 120)})`);
  }
}

/**
 * @param {string} repoRoot
 */
export function loadPostgresPassword(repoRoot) {
  const envPath = `${repoRoot}/apps/postgres/.env`;
  const text = fs.readFileSync(envPath, "utf8");
  const m = /^POSTGRES_PASSWORD=(.*)$/m.exec(text);
  if (!m) {
    throw new Error(`missing POSTGRES_PASSWORD in ${envPath}`);
  }
  return m[1].trim();
}

export function icPremergeDockerLeftovers() {
  const { containers, networks } = listIcPremergeDockerResources();
  return { containers, networks, count: containers.length + networks.length };
}

/**
 * @param {number} pid
 */
export function premergeProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.category
 * @param {string} opts.label
 * @param {RegExp} opts.pattern
 * @param {string} opts.head
 * @param {string} opts.password
 * @param {Record<string, string>} [opts.extraEnv]
 * @param {string} [opts.outsideVaultMarker]
 */
export async function runPremergeSigintOnce(opts) {
  const { category, label, pattern, head, password, extraEnv = {}, outsideVaultMarker } = opts;
  const intDelayMs =
    category === "js-sdk-leg" ? 450 : category === "fail-cleanup" ? 50 : 80;
  const timeoutMs =
    category === "js-sdk-leg" ? 1_500_000 : category === "fail-cleanup" ? 120_000 : 900_000;

  const envPairs = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`);
  const inner = [
    "cd /workspace/apps/js-sdk",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    `EXPECTED_SHA=${head}`,
    `POSTGRES_PASSWORD=${password}`,
    ...envPairs,
    "node scripts/premerge.mjs",
  ].join(" && ");

  const beforeDocker = icPremergeDockerLeftovers();
  const child = spawn("bash", ["-lc", `sg docker -c ${JSON.stringify(inner)}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  let hit = 0;
  /** @type {number | null} */
  let premergePid = null;
  let intSent = false;

  const signalPremerge = () => {
    if (intSent) {
      return;
    }
    intSent = true;
    if (premergePid === null) {
      premergePid = parsePremergeNodePidFromLog(log);
    }
    if (premergePid === null) {
      return;
    }
    try {
      assertPremergeNodePid(premergePid);
      process.kill(premergePid, "SIGINT");
    } catch {
      /* ignore */
    }
  };

  const onData = (chunk) => {
    log += chunk;
    if (premergePid === null) {
      const parsed = parsePremergeNodePidFromLog(log);
      if (parsed !== null) {
        premergePid = parsed;
      }
    }
    if (!hit && pattern.test(log)) {
      hit = 1;
      setTimeout(signalPremerge, intDelayMs);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const code = await Promise.race([
    new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1))),
    new Promise((resolve) =>
      setTimeout(() => {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
        resolve(124);
      }, timeoutMs),
    ),
  ]);

  await new Promise((r) => setTimeout(r, 1500));
  const tmpDir = parsePremergeTmpDirFromLog(log);
  let tmpLeft = tmpDir && fs.existsSync(tmpDir) ? 1 : 0;
  if (tmpLeft && tmpDir) {
    await new Promise((r) => setTimeout(r, 8000));
    tmpLeft = fs.existsSync(tmpDir) ? 1 : 0;
  }

  const afterDocker = icPremergeDockerLeftovers();
  const premergeAlive = premergePid !== null && premergeProcessAlive(premergePid) ? 1 : 0;
  const markerOk =
    !outsideVaultMarker || (outsideVaultMarker && fs.existsSync(outsideVaultMarker)) ? 1 : 0;
  let vaultOutside = 0;
  try {
    vaultOutside = Number(
      spawnSync("pgrep", ["-cf", "[v]ault-agent-serve.mjs"], { encoding: "utf8" }).stdout.trim() ||
        "0",
    );
  } catch {
    vaultOutside = -1;
  }

  const ok =
    code === 130 &&
    tmpLeft === 0 &&
    hit === 1 &&
    premergeAlive === 0 &&
    afterDocker.count === 0 &&
    markerOk === 1;

  return {
    category,
    label,
    code,
    tmpLeft,
    hit,
    premergePid,
    premergeAlive,
    vaultOutside,
    markerOk,
    dockerBefore: beforeDocker,
    dockerAfter: afterDocker,
    ok,
  };
}
