import os from "node:os";
import path from "node:path";

import { infinitecontextHome } from "./client-config.mjs";
import {
  createCliFileObjectStoreLocalState,
  createDaemonDbObjectStoreLocalState,
} from "./object-store-local-state-persist.mjs";

function expandHome(filePath) {
  const trimmed = String(filePath ?? "").trim();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveDaemonDbPathFromEnv(env = process.env) {
  const raw = env.INFINITECONTEXT_DB_FILE ?? path.join(infinitecontextHome(), "daemon.db");
  return path.resolve(expandHome(raw));
}

/** Default CLI sync-cli-state path (~/.infinitecontext/sync-cli-state.json). */
export function defaultCliObjectStoreStatePath() {
  return path.join(infinitecontextHome(), "sync-cli-state.json");
}

/**
 * @param {{ mode?: 'cli' | 'daemon', cliStatePath?: string, dbPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function createProductionObjectStoreLocalState(options = {}) {
  const mode = options.mode ?? (options.env?.INFINITECONTEXT_DB_FILE ? "daemon" : "cli");
  if (mode === "daemon") {
    const dbPath = options.dbPath ?? resolveDaemonDbPathFromEnv(options.env ?? process.env);
    return createDaemonDbObjectStoreLocalState(dbPath);
  }
  const cliPath = options.cliStatePath ?? defaultCliObjectStoreStatePath();
  return createCliFileObjectStoreLocalState(cliPath);
}
