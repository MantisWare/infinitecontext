import os from "node:os";
import path from "node:path";

import { infinitecontextHome } from "./client-config.mjs";
import { storagePathsReferToSameLocation } from "./storage/storage-path-compare.mjs";
import {
  createCliFileObjectStoreLocalState,
  createDaemonDbObjectStoreLocalState,
  defaultObjectStoreSyncStatePath,
} from "./object-store-local-state-persist.mjs";

function expandHome(filePath) {
  const trimmed = String(filePath ?? "").trim();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveDefaultDaemonDbPath(env = process.env) {
  return path.resolve(expandHome(path.join(infinitecontextHome(), "daemon.db")));
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveDaemonDbPathFromEnv(env = process.env) {
  const raw = env.INFINITECONTEXT_DB_FILE ?? path.join(infinitecontextHome(), "daemon.db");
  return path.resolve(expandHome(raw));
}

/**
 * Trust audit loads every distinct daemon.db (default home path plus INFINITECONTEXT_DB_FILE when set).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function resolveDaemonDbPathsForTrustAudit(env = process.env) {
  /** @type {string[]} */
  const paths = [resolveDefaultDaemonDbPath(env)];
  const overrideRaw = String(env.INFINITECONTEXT_DB_FILE ?? "").trim();
  if (overrideRaw) {
    const overridePath = path.resolve(expandHome(overrideRaw));
    if (!paths.some((existing) => storagePathsReferToSameLocation(existing, overridePath))) {
      paths.push(overridePath);
    }
  }
  return paths;
}

/** @deprecated use defaultObjectStoreSyncStatePath */
export function defaultCliObjectStoreStatePath() {
  return defaultObjectStoreSyncStatePath();
}

/**
 * @param {{ mode?: 'cli' | 'daemon', cliStatePath?: string, dbPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function createProductionObjectStoreLocalState(options = {}) {
  const mode = options.mode ?? "cli";
  if (mode === "daemon") {
    const dbPath = options.dbPath ?? resolveDaemonDbPathFromEnv(options.env ?? process.env);
    return createDaemonDbObjectStoreLocalState(dbPath);
  }
  const cliPath = options.cliStatePath ?? defaultCliObjectStoreStatePath();
  return createCliFileObjectStoreLocalState(cliPath);
}
