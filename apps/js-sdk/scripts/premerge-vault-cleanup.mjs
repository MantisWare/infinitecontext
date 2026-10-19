import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} sdkRoot
 */
export function listVaultAgentServePids() {
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
      if (cmdline.includes("vault-agent-serve")) {
        pids.push(pid);
      }
    } catch {
      /* ignore */
    }
  }
  return pids;
}

/**
 * @param {string} sdkRoot
 */
export function syncVaultAgentCleanup(sdkRoot) {
  const runner = path.join(sdkRoot, "scripts/premerge-vault-agent-shutdown.mjs");
  spawnSync(process.execPath, [runner], {
    cwd: sdkRoot,
    env: process.env,
    stdio: "ignore",
    timeout: 8000,
  });
  for (const pid of listVaultAgentServePids()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  for (const pid of listVaultAgentServePids()) {
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
  syncVaultAgentCleanup(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
