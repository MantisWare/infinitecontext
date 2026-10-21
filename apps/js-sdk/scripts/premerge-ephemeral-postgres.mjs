import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PREMERGE_DOCKER_LABEL = "com.infinitecontext.premerge=true";

/**
 * @param {string} repoRoot
 */
/**
 * @param {string} repoRoot
 * @param {{ port: string, dbName: string, password: string, user: string }} target
 */
function migrateEphemeralDatabase(repoRoot, target) {
  const script = path.join(repoRoot, "apps/postgres/scripts/verify-migration-chain.sh");
  const res = spawnSync("bash", [script], {
    cwd: path.join(repoRoot, "apps/postgres"),
    encoding: "utf8",
    timeout: 300_000,
    env: {
      ...process.env,
      MIGRATION_VERIFY_USE_HOST: "1",
      MIGRATION_VERIFY_USE_DOCKER: "",
      POSTGRES_PASSWORD: target.password,
      POSTGRES_USER: target.user,
      POSTGRES_DB: target.dbName,
      PGHOST: "127.0.0.1",
      PGPORT: target.port,
    },
  });
  if (res.status !== 0) {
    throw new Error(
      `premerge: migration verify failed for ${target.dbName} on port ${target.port}: ${res.stderr || res.stdout}`,
    );
  }
}

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
 * @param {string} repoRoot
 * @param {string} project
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function tearDownEphemeralPostgresProject(repoRoot, project, env = process.env) {
  const composeFile = path.join(repoRoot, "apps/postgres/compose.yaml");
  const composeEnv = {
    ...env,
    COMPOSE_PROJECT_NAME: project,
  };
  return spawnSync(
    "docker",
    ["compose", "-f", composeFile, "-p", project, "down", "-v", "--remove-orphans"],
    {
      cwd: path.dirname(composeFile),
      env: composeEnv,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
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
    return spawnSync("docker", ["compose", ...args], {
      cwd: path.dirname(composeFile),
      env: composeEnv,
      encoding: "utf8",
      timeout: 300_000,
    });
  }

  /** @type {(() => void) | null} */
  let teardown = null;
  const cleanup = () => {
    if (!teardown) {
      return;
    }
    const fn = teardown;
    teardown = null;
    fn();
  };

  const up = dockerCompose(["-f", composeFile, "-p", project, "up", "-d", "postgres"]);
  if (up.status !== 0) {
    throw new Error(
      `premerge: ephemeral Postgres failed to start (project=${project}): ${up.stderr || up.stdout}`,
    );
  }
  teardown = () => {
    const down = tearDownEphemeralPostgresProject(repoRoot, project, composeEnv);
    if (down.status !== 0) {
      console.error(
        `premerge: ephemeral Postgres teardown failed (project=${project}): ${down.stderr || down.stdout}`,
      );
    }
  };

  const pgEnv = { ...env, PGPASSWORD: password };
  let pgReady = false;
  for (let i = 0; i < 40; i += 1) {
    const ready = spawnSync(
      "psql",
      ["-h", "127.0.0.1", "-p", port, "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"],
      { encoding: "utf8", env: pgEnv },
    );
    if (ready.status === 0) {
      pgReady = true;
      break;
    }
    spawnSync("sleep", ["1"]);
  }
  if (!pgReady) {
    cleanup();
    throw new Error(
      `premerge: ephemeral Postgres not ready on 127.0.0.1:${port} after 40s (project=${project})`,
    );
  }

  try {
    for (const dbName of [syncDb, vaultDb]) {
      const created = spawnSync(
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
      if (created.status !== 0) {
        throw new Error(
          `premerge: CREATE DATABASE ${dbName} failed: ${created.stderr || created.stdout}`,
        );
      }
      migrateEphemeralDatabase(repoRoot, { port, dbName, password, user });
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  const syncUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${syncDb}`;
  const vaultUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${vaultDb}`;

  process.env.PGHOST = "127.0.0.1";
  process.env.PGPORT = port;
  process.env.SYNC_E2E_DATABASE_URL = syncUrl;
  process.env.VAULT_E2E_DATABASE_URL = vaultUrl;

  return { project, port, syncDb, vaultDb, cleanup };
}

/**
 * @param {string} [projectPrefix]
 */
export function listIcPremergeDockerResources(projectPrefix = "ic_premerge") {
  const ps = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  const nets = spawnSync("docker", ["network", "ls", "--format", "{{.Name}}"], { encoding: "utf8" });
  const vols = spawnSync("docker", ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf8" });
  const names = String(ps.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.includes(projectPrefix));
  const networks = String(nets.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.includes(projectPrefix));
  const volumes = String(vols.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.includes(projectPrefix));
  return {
    containers: names,
    networks,
    volumes,
    count: names.length + networks.length + volumes.length,
    label: PREMERGE_DOCKER_LABEL,
  };
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
