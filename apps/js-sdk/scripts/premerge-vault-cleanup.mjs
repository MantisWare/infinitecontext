import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPremergeVaultAgentPids } from "../lib/premerge-vault-registry.mjs";

/**
 * @param {number} pid
 * @returns {Record<string, string>}
 */
function readProcEnviron(pid) {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`);
    for (const part of raw.toString("utf8").split("\0")) {
      if (!part) {
        continue;
      }
      const eq = part.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      out[part.slice(0, eq)] = part.slice(eq + 1);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Vault-agent-serve processes belonging to exactly this HOME (premerge isolated home).
 * @param {string} premergeHome
 */
export function listVaultAgentServePidsForHome(premergeHome) {
  const home = path.resolve(premergeHome);
  /** @type {number[]} */
  const pids = [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) {
      continue;
    }
    const pid = Number(ent);
    try {
      const cmdline = fs.readFileSync(`/proc/${ent}/cmdline`, "utf8");
      if (!cmdline.includes("vault-agent-serve")) {
        continue;
      }
      const env = readProcEnviron(pid);
      if (path.resolve(env.HOME ?? "") === home) {
        pids.push(pid);
      }
    } catch {
      /* ignore */
    }
  }
  return pids;
}

/**
 * @param {object} opts
 * @param {string} opts.sdkRoot
 * @param {string} opts.premergeHome
 * @param {string} [opts.vaultPidRegistryPath]
 */
export function syncVaultAgentCleanup(opts) {
  const { sdkRoot, premergeHome, vaultPidRegistryPath } = opts;
  const runner = path.join(sdkRoot, "scripts/premerge-vault-agent-shutdown.mjs");
  spawnSync(process.execPath, [runner], {
    cwd: sdkRoot,
    env: { ...process.env, HOME: premergeHome },
    stdio: "ignore",
    timeout: 8000,
  });
  const killSet = new Set([
    ...readPremergeVaultAgentPids(vaultPidRegistryPath),
    ...listVaultAgentServePidsForHome(premergeHome),
  ]);
  for (const pid of killSet) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  for (const pid of killSet) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  syncVaultAgentCleanup({
    sdkRoot,
    premergeHome: process.env.HOME ?? "",
    vaultPidRegistryPath: process.env.IC_PREMERGE_VAULT_PID_REGISTRY,
  });
}
