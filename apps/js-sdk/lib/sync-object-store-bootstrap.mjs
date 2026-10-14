import crypto from "node:crypto";

import { getUnlockedDek } from "./vault-session.mjs";
import { readConfigFile, writeConfigFile, resolveBaseUrl } from "./client-config.mjs";
import { createLocalObjectStore } from "./storage/local-object-store.mjs";
import { setDefaultSyncTransport } from "./sync-transport.mjs";
import { isHostedStorageBackend } from "./sync-storage-backend.mjs";
import { resolveDaemonDbPathFromEnv } from "./object-store-sync-runtime.mjs";
import { normalizeDeviceUuid } from "./storage/layout.mjs";

/** @type {import('./storage/local-object-store.mjs').createLocalObjectStore extends (...args: any) => Promise<infer R> ? R : never} */
let openLocalStore = null;

/**
 * @param {{ mode?: 'cli' | 'daemon', baseUrl?: string, config?: Record<string, unknown>, env?: NodeJS.ProcessEnv, dbPath?: string }} [options]
 */
export async function configureObjectStoreSyncTransportIfNeeded(options = {}) {
  const config = options.config ?? readConfigFile();
  if (isHostedStorageBackend(config)) return null;

  const baseUrl = options.baseUrl ?? resolveBaseUrl({ config, env: options.env });
  const dek = await getUnlockedDek({ baseUrl });
  if (!dek) {
    throw new Error("Vault unlock required for local object store sync");
  }

  const deviceUuid = resolveOrCreateDeviceUuid(config);
  const mode = options.mode ?? "cli";
  const dbPath = options.dbPath ?? resolveDaemonDbPathFromEnv(options.env ?? process.env);

  if (openLocalStore?.close) {
    try {
      await openLocalStore.close();
    } catch {
      /* ignore */
    }
  }

  openLocalStore = await createLocalObjectStore({
    dek,
    deviceUuid,
    config,
    env: options.env,
    sync: { mode, persist: true, dbPath },
    layoutPrefix: "accounts/local",
  });
  setDefaultSyncTransport(openLocalStore.transport);
  return openLocalStore;
}

/** @param {Record<string, unknown>} config */
function resolveOrCreateDeviceUuid(config) {
  const envUuid = String(process.env.INFINITECONTEXT_DEVICE_UUID ?? "").trim();
  if (envUuid) return normalizeDeviceUuid(envUuid);
  const storage = config.storage;
  if (storage && typeof storage === "object" && !Array.isArray(storage)) {
    const fromConfig = String(/** @type {Record<string, unknown>} */ (storage).deviceUuid ?? "").trim();
    if (fromConfig) return normalizeDeviceUuid(fromConfig);
  }
  const created = crypto.randomUUID();
  const nextStorage =
    storage && typeof storage === "object" && !Array.isArray(storage)
      ? { .../** @type {Record<string, unknown>} */ (storage), deviceUuid: created }
      : { deviceUuid: created };
  writeConfigFile({ storage: nextStorage });
  return normalizeDeviceUuid(created);
}
