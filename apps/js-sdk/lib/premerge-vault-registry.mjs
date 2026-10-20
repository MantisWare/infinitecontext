import fs from "node:fs";
import path from "node:path";

/**
 * @param {string | undefined} registryPath
 * @param {number} pid
 */
export function registerPremergeVaultAgentPid(registryPath, pid) {
  if (!registryPath || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.appendFileSync(registryPath, `${pid}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string | undefined} registryPath
 * @returns {number[]}
 */
export function readPremergeVaultAgentPids(registryPath) {
  if (!registryPath) {
    return [];
  }
  try {
    return fs
      .readFileSync(registryPath, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}
