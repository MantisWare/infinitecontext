import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listIcPremergeDockerResources } from "./premerge-ephemeral-postgres.mjs";
import { listVaultAgentServePidsForHome } from "./premerge-vault-cleanup.mjs";

const premergeSigintSdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string | URL} [importMetaUrl]
 */
export function resolvePremergeSigintSdkRoot(importMetaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

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
 * @param {string} log
 * @returns {string | undefined}
 */
export function parsePremergeHomeFromLog(log) {
  const m = /premerge: isolated HOME=(\S+)/.exec(log);
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

export function icPremergeDockerInventory() {
  return listIcPremergeDockerResources();
}

/**
 * @param {string | undefined} premergeHome
 */
export function countPremergeVaultAgentLeaks(premergeHome) {
  if (!premergeHome) {
    return 0;
  }
  return listVaultAgentServePidsForHome(premergeHome).length;
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
/**
 * @param {string} category
 * @param {number} defaultMs
 */
function resolvePremergeSigintRaceTimeoutMs(category, defaultMs) {
  const harness = String(process.env.IC_PREMERGE_SIGINT_TEST_HARNESS ?? "").trim() === "1";
  const override = Number(process.env.IC_PREMERGE_SIGINT_RACE_TIMEOUT_MS ?? "");
  if (harness && Number.isFinite(override) && override > 0) {
    return override;
  }
  return defaultMs;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 */
export function premergeSigintRaceKillChild(child) {
  child.kill("SIGKILL");
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
 * @param {(child: import("node:child_process").ChildProcess) => void} [opts.testRaceKillChild]
 * @param {string} [opts.testInnerShell]
 */
export async function runPremergeSigintOnce(opts) {
  const {
    category,
    label,
    pattern,
    head,
    password,
    extraEnv = {},
    outsideVaultMarker,
    testRaceKillChild,
    testInnerShell,
  } = opts;
  const intDelayMs =
    category === "js-sdk-leg" ? 450 : category === "fail-cleanup" ? 0 : 80;
  const defaultTimeoutMs =
    category === "js-sdk-leg" ? 1_500_000 : category === "fail-cleanup" ? 900_000 : 900_000;
  const timeoutMs = resolvePremergeSigintRaceTimeoutMs(category, defaultTimeoutMs);
  const raceKillChild = testRaceKillChild ?? premergeSigintRaceKillChild;

  const envPairs = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`);
  const inner =
    testInnerShell ??
    [
      "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      "PREMERGE_MUTANT=",
      `EXPECTED_SHA=${head}`,
      `POSTGRES_PASSWORD=${password}`,
      ...envPairs,
      "node scripts/premerge.mjs",
    ].join(" ");

  const dockerWrap = String(process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP ?? "sg docker -c").trim();
  const shellCmd = dockerWrap ? `${dockerWrap} ${JSON.stringify(inner)}` : inner;
  const beforeDocker = icPremergeDockerInventory();
  const child = spawn("bash", ["-lc", shellCmd], {
    cwd: premergeSigintSdkRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "",
    },
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
    if (premergePid === null) {
      premergePid = parsePremergeNodePidFromLog(log);
    }
    if (premergePid === null) {
      return;
    }
    try {
      assertPremergeNodePid(premergePid);
      process.kill(premergePid, "SIGINT");
      intSent = true;
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
      if (intDelayMs <= 0) {
        signalPremerge();
      } else {
        setTimeout(signalPremerge, intDelayMs);
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let raceTimeoutId;
  /** @type {string | null} */
  let shellExitSignal = null;
  let raceKillChildMarkedKilled = false;
  child.on("exit", (_code, signal) => {
    shellExitSignal = signal;
  });
  const code = await Promise.race([
    new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1))),
    new Promise((resolve) => {
      raceTimeoutId = setTimeout(() => {
        try {
          raceKillChild(child);
          raceKillChildMarkedKilled = child.killed === true;
        } catch {
          /* ignore */
        }
        resolve(124);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (raceTimeoutId !== undefined) {
      clearTimeout(raceTimeoutId);
    }
  });
  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(undefined);
      return;
    }
    child.once("close", () => resolve(undefined));
  });
  let shellAliveAfterRace = 0;
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid, 0);
      shellAliveAfterRace = 1;
    } catch {
      shellAliveAfterRace = 0;
    }
  }

  if (!hit && pattern.test(log)) {
    hit = 1;
    if (!intSent && premergeProcessAlive(premergePid ?? -1)) {
      signalPremerge();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  const tmpDir = parsePremergeTmpDirFromLog(log);
  const premergeHome = parsePremergeHomeFromLog(log);
  let tmpLeft = tmpDir && fs.existsSync(tmpDir) ? 1 : 0;
  if (tmpLeft && tmpDir) {
    await new Promise((r) => setTimeout(r, 8000));
    tmpLeft = fs.existsSync(tmpDir) ? 1 : 0;
  }

  const afterDocker = icPremergeDockerInventory();
  const vaultBefore = countPremergeVaultAgentLeaks(premergeHome);
  const vaultAfter = countPremergeVaultAgentLeaks(premergeHome);
  const premergeAlive = premergePid !== null && premergeProcessAlive(premergePid) ? 1 : 0;
  const markerOk =
    !outsideVaultMarker || (outsideVaultMarker && fs.existsSync(outsideVaultMarker)) ? 1 : 0;

  const dockerOk =
    beforeDocker.count === 0 &&
    afterDocker.count === 0 &&
    beforeDocker.containers.length === 0 &&
    beforeDocker.networks.length === 0 &&
    beforeDocker.volumes.length === 0 &&
    afterDocker.containers.length === 0 &&
    afterDocker.networks.length === 0 &&
    afterDocker.volumes.length === 0;

  const exitOk =
    code === 130 ||
    (category === "fail-cleanup" && code === 92 && /SYNTHETIC/.test(log));
  const ok =
    exitOk &&
    tmpLeft === 0 &&
    hit === 1 &&
    premergeAlive === 0 &&
    dockerOk &&
    vaultBefore === 0 &&
    vaultAfter === 0 &&
    markerOk === 1;

  return {
    category,
    label,
    code,
    tmpLeft,
    hit,
    premergePid,
    premergeAlive,
    vaultBefore,
    vaultAfter,
    markerOk,
    dockerBefore: beforeDocker,
    dockerAfter: afterDocker,
    shellExitSignal,
    shellAliveAfterRace,
    raceKillChildMarkedKilled,
    ok,
  };
}

