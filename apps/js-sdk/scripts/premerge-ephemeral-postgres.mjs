import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} repoRoot
 */
function pickFreePort() {
  const res = spawnSync("python3", ["-c", "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error("premerge: could not pick a free TCP port for ephemeral Postgres");
  }
  return String(res.stdout).trim();
}

/**
 * Starts an isolated Postgres (unique compose project, random port). Never uses 5433 or the dev DB name.
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 */
export function startEphemeralPostgresForPremerge(repoRoot, env = process.env) {
  const password = String(env.POSTGRES_PASSWORD ?? "").trim();
  if (!password) {
    throw new Error(
      "premerge: POSTGRES_PASSWORD is required. premerge starts its own ephemeral Postgres and never touches infinitecontext:db:up on 5433.",
    );
  }

  const composeFile = path.join(repoRoot, "apps/postgres/compose.yaml");
  const project = `ic_premerge_pg_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const port = pickFreePort();
  const user = "infinitecontext";
  const syncDb = "ic_premerge_sync_e2e_test";
  const vaultDb = "ic_premerge_vault_e2e_test";

  const composeEnv = {
    ...env,
    COMPOSE_PROJECT_NAME: project,
    POSTGRES_PORT: port,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: "postgres",
  };

  function dockerCompose(args) {
    let res = spawnSync("docker", ["compose", ...args], {
      cwd: path.dirname(composeFile),
      env: composeEnv,
      encoding: "utf8",
    });
    if (res.status !== 0 && process.platform !== "win32") {
      res = spawnSync("sudo", ["-E", "docker", "compose", ...args], {
        cwd: path.dirname(composeFile),
        env: composeEnv,
        encoding: "utf8",
      });
    }
    return res;
  }

  const up = dockerCompose(["-f", composeFile, "-p", project, "up", "-d", "postgres"]);
  if (up.status !== 0) {
    throw new Error(
      `premerge: ephemeral Postgres failed to start (project=${project}): ${up.stderr || up.stdout}`,
    );
  }

  const pgEnv = { ...env, PGPASSWORD: password };
  for (let i = 0; i < 40; i += 1) {
    const ready = spawnSync(
      "psql",
      ["-h", "127.0.0.1", "-p", port, "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"],
      { encoding: "utf8", env: pgEnv },
    );
    if (ready.status === 0) break;
    spawnSync("sleep", ["1"]);
  }

  for (const dbName of [syncDb, vaultDb]) {
    spawnSync(
      "psql",
      [
        "-h",
        "127.0.0.1",
        "-p",
        port,
        "-U",
        user,
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `CREATE DATABASE "${dbName}" OWNER "${user}";`,
      ],
      { encoding: "utf8", env: pgEnv },
    );
  }

  const syncUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${syncDb}`;
  const vaultUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${vaultDb}`;

  process.env.PGHOST = "127.0.0.1";
  process.env.PGPORT = port;
  process.env.SYNC_E2E_DATABASE_URL = syncUrl;
  process.env.VAULT_E2E_DATABASE_URL = vaultUrl;

  /** @type {() => void} */
  const cleanup = () => {
    dockerCompose(["-f", composeFile, "-p", project, "down", "-v", "--remove-orphans"]);
  };

  return { project, port, syncDb, vaultDb, cleanup };
}

/**
 * Refuse dev DB URLs when explicitly set by the caller.
 * @param {NodeJS.ProcessEnv} env
 */
export function assertPremergePostgresUrlsSafe(env = process.env) {
  for (const [label, raw] of [
    ["SYNC_E2E_DATABASE_URL", env.SYNC_E2E_DATABASE_URL],
    ["VAULT_E2E_DATABASE_URL", env.VAULT_E2E_DATABASE_URL],
  ]) {
    const url = String(raw ?? "").trim();
    if (!url) continue;
    const parsed = new URL(url.replace(/^postgres:/, "postgresql:"));
    const db = parsed.pathname.replace(/^\//, "");
    if (db === "infinitecontext" || (!db.endsWith("_test") && !db.endsWith("_e2e_test"))) {
      throw new Error(
        `premerge: ${label} database "${db}" is not a throwaway test database (name must end with _test or _e2e_test). Refusing to run migration verify against a dev database.`,
      );
    }
    if (parsed.port === "5433" && db === "infinitecontext") {
      throw new Error(`premerge: ${label} must not target the dev infinitecontext database on 5433.`);
    }
  }
}
