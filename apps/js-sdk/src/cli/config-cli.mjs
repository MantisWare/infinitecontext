import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  CLIENT_CONFIG_KEYS,
  defaultConfigPath,
  infinitecontextHome,
  KEYS_AND_SERVICES_DOC_URL,
  maskSecret,
  readConfigFile,
  describeActiveServer,
  resolveBaseUrl,
  resolveBaseUrlSource,
  resolveSettingSource,
  writeConfigFile,
} from "../../lib/client-config.mjs";
import { getValidAccessToken, hasSessionCredentials, loadCredentials } from "../../lib/credentials.mjs";
import { resolveDaemonDbPathFromEnv } from "../../lib/object-store-sync-runtime.mjs";

function printHelp() {
  console.log(`Usage: infinitecontext config <command>

Commands:
  show      Print effective settings (secrets masked) and their source
  set       Set a value: infinitecontext config set <key> <value>
  unset     Remove a config file value: infinitecontext config unset <key>
  path      Print the config file path
  doctor    Check server connectivity and authentication
  wizard    Run the interactive setup wizard (same as bare \`config\`)

Keys for set/unset:
  server    API base URL (also INFINITECONTEXT_BASE_URL)
  apiKey    Legacy project API key (also INFINITECONTEXT_API_KEY)

Documentation: ${KEYS_AND_SERVICES_DOC_URL}
`);
}

function keyDefByName(name) {
  const key = String(name ?? "").trim();
  const def = CLIENT_CONFIG_KEYS.find((k) => k.key === key || k.configField === key);
  if (!def) {
    throw new Error(`Unknown config key "${key}". Run \`infinitecontext config show\` for keys. See ${KEYS_AND_SERVICES_DOC_URL}`);
  }
  return def;
}

function cmdShow() {
  const active = describeActiveServer(resolveBaseUrl());
  const src = resolveBaseUrlSource();
  console.log(`Active server: ${active.baseUrl}`);
  console.log(`  kind:   ${active.label}`);
  console.log(`  source: ${src.source}${src.envVar ? ` (${src.envVar})` : ""}\n`);
  console.log(`Config file: ${defaultConfigPath()}\n`);
  for (const def of CLIENT_CONFIG_KEYS) {
    const { source, value } = resolveSettingSource(def);
    const display = def.secret ? maskSecret(value) : (value || "(not set)");
    console.log(`${def.label} (${def.key})`);
    console.log(`  value:  ${display}`);
    console.log(`  source: ${source}${def.env ? ` (${def.env})` : ""}`);
    console.log("");
  }

  const session = hasSessionCredentials();
  console.log("Account session (credentials.json)");
  console.log(`  value:  ${session ? "present (tokens masked)" : "(not signed in)"}`);
  console.log(`  source: ${session ? credentialsPathLabel() : "—"}`);
  console.log("");
}

function credentialsPathLabel() {
  return `${infinitecontextHome()}/credentials.json`;
}

function cmdSet(keyName, rawValue) {
  const def = keyDefByName(keyName);
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new Error(`Missing value for ${def.key}. Example: infinitecontext config set ${def.key} <value>`);
  }
  if (def.key === "server") {
    writeConfigFile({ baseUrl: value.replace(/\/+$/, "") });
    console.log(`Set ${def.label} in config.json`);
    return;
  }
  if (def.key === "apiKey") {
    writeConfigFile({ apiKey: value });
    console.log(`Set ${def.label} in config.json`);
    return;
  }
}

function cmdUnset(keyName) {
  const def = keyDefByName(keyName);
  const config = readConfigFile();
  if (def.configField && Object.prototype.hasOwnProperty.call(config, def.configField)) {
    delete config[def.configField];
    fs.writeFileSync(defaultConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`Removed ${def.label} from config.json`);
    return;
  }
  console.log(`No ${def.label} in config.json (clear ${def.env} in your shell if set).`);
}

function cmdPath() {
  console.log(defaultConfigPath());
}

async function checkStorageBackendPolicy() {
  const { readConfigFile } = await import("../../lib/client-config.mjs");
  const { resolveStorageBackendId } = await import("../../lib/sync-storage-backend.mjs");
  const backend = resolveStorageBackendId(readConfigFile());
  console.log(`○ storage.backend=${backend || "hosted"}`);
  if (backend === "folder") {
    console.log(
      "○ folder sync: per-device manifest merge (no shared manifest LWW); log segment GC disabled",
    );
  }
}

async function checkLocalSyncReplicaFiles() {
  const home = infinitecontextHome();
  const { hydrateSyncReplica, wrapReplicaJsonParseError } = await import("../../lib/sync-replica-state.mjs");
  const { ObjectStoreSyncStateError } = await import("../../lib/object-store-state-errors.mjs");
  const { DatabaseSync } = await import("node:sqlite");

  /** @param {string} label @param {() => void} load */
  function tryLoad(label, load) {
    try {
      load();
      console.log(`✓ ${label}`);
    } catch (error) {
      const corrupt =
        error instanceof ObjectStoreSyncStateError && error.code === "corrupt_state";
      console.log(`✗ ${label}${corrupt ? " (corrupt_state)" : ""}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  const cliReplicaPath = path.join(home, "sync-replica.json");
  if (fs.existsSync(cliReplicaPath)) {
    tryLoad("CLI sync replica (~/.infinitecontext/sync-replica.json)", () => {
      try {
        hydrateSyncReplica(JSON.parse(fs.readFileSync(cliReplicaPath, "utf8")));
      } catch (err) {
        wrapReplicaJsonParseError(err);
      }
    });
  }

  const dbPath = resolveDaemonDbPathFromEnv(process.env);
  if (fs.existsSync(dbPath)) {
    tryLoad(`daemon.db sync_replica_state (${dbPath})`, () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT replica_json FROM sync_replica_state WHERE id = 1").get();
        if (row?.replica_json) {
          try {
            hydrateSyncReplica(JSON.parse(String(row.replica_json)));
          } catch (err) {
            wrapReplicaJsonParseError(err);
          }
        }
      } finally {
        db.close();
      }
    });
  }
}

async function cmdDoctor() {
  let baseUrl;
  try {
    baseUrl = resolveBaseUrl({ required: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await checkStorageBackendPolicy();
    await checkLocalSyncReplicaFiles();
    return;
  }

  console.log(`Checking ${baseUrl} …`);
  try {
    const health = await fetch(`${baseUrl}/health`);
    console.log(health.ok ? "✓ GET /health" : `✗ GET /health (${health.status})`);
  } catch (error) {
    console.error(`✗ Cannot reach server: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    await checkStorageBackendPolicy();
    await checkLocalSyncReplicaFiles();
    return;
  }

  try {
    const cfgRes = await fetch(`${baseUrl}/health/config`);
    if (cfgRes.ok) {
      const body = await cfgRes.json();
      console.log("✓ GET /health/config", JSON.stringify(body));
    } else {
      console.log(`○ GET /health/config (${cfgRes.status})`);
    }
  } catch {
    console.log("○ GET /health/config (unavailable)");
  }

  const apiKey = resolveSettingSource(CLIENT_CONFIG_KEYS[1]).value;
  if (apiKey) {
    const res = await fetch(`${baseUrl}/contexts?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    console.log(res.ok ? "✓ API key auth (/contexts)" : `✗ API key auth (${res.status})`);
    if (!res.ok) process.exitCode = 1;
  } else if (hasSessionCredentials()) {
    const session = await getValidAccessToken({ baseUrl });
    if (!session?.accessToken) {
      console.log("✗ Account session expired — run `infinitecontext login`");
      process.exitCode = 1;
    } else {
      const res = await fetch(`${baseUrl}/contexts?limit=1`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      console.log(res.ok ? "✓ Account session auth (/contexts)" : `✗ Account session auth (${res.status})`);
      if (!res.ok) process.exitCode = 1;
    }
  } else {
    console.log("○ No API key or account session configured — run `infinitecontext login` or set apiKey");
    process.exitCode = 1;
  }

  await checkStorageBackendPolicy();
  await checkLocalSyncReplicaFiles();
}

export async function runConfigCli(argv = process.argv.slice(3)) {
  const sub = String(argv[0] ?? "").trim().toLowerCase();
  if (!sub || sub === "wizard") {
    const { onboard } = await import("./onboarding.mjs");
    return onboard();
  }

  switch (sub) {
    case "show":
      cmdShow();
      return;
    case "set":
      cmdSet(argv[1], argv[2]);
      return;
    case "unset":
      cmdUnset(argv[1]);
      return;
    case "path":
      cmdPath();
      return;
    case "doctor":
      await cmdDoctor();
      return;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    default:
      console.error(`Unknown config command: ${argv[0]}`);
      printHelp();
      process.exitCode = 1;
  }
}
