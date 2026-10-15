import process from "node:process";

import { getUnlockedDek } from "../../lib/vault-session.mjs";
import { readConfigFile, resolveBaseUrl } from "../../lib/client-config.mjs";
import { configureObjectStoreSyncTransportIfNeeded } from "../../lib/sync-object-store-bootstrap.mjs";
import { createLocalObjectStore } from "../../lib/storage/local-object-store.mjs";
import { isHostedStorageBackend } from "../../lib/sync-storage-backend.mjs";
import { removeManifestDevice } from "../../lib/storage/storage-manifest.mjs";
import { canonicalDevH, deriveDevH } from "../../lib/storage/layout.mjs";
import { formatSyncCliError } from "../../lib/sync-errors.mjs";

export async function runStorageCli(subcommand, args) {
  const baseUrl = resolveBaseUrl();
  const cmd = String(subcommand ?? "help").toLowerCase();

  const run = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      const msg = formatSyncCliError(error);
      if (msg !== error?.message) {
        console.error(msg);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  };

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(`Usage: infinitecontext storage <command>

Commands:
  devices remove <devH>   Drop a lagging device from manifest GC participation

Environment:
  Same as sync (local object store requires vault unlock)
`);
    return;
  }

  if (cmd === "devices") {
    const action = String(args[0] ?? "help").toLowerCase();
    if (action === "remove") {
      const devHRaw = args[1];
      if (!devHRaw) throw new Error("Usage: infinitecontext storage devices remove <devH>");
      return run(async () => {
        const config = readConfigFile();
        if (isHostedStorageBackend(config)) {
          throw new Error("storage devices remove requires local object store sync");
        }
        await configureObjectStoreSyncTransportIfNeeded({ mode: "cli", baseUrl });
        const unlocked = await getUnlockedDek({ baseUrl });
        if (!unlocked?.dek) throw new Error("Vault unlock required");
        const storage = config.storage;
        const deviceUuid =
          storage && typeof storage === "object" && !Array.isArray(storage)
            ? String(/** @type {Record<string, unknown>} */ (storage).deviceUuid ?? "")
            : "";
        const store = await createLocalObjectStore({
          dek: unlocked.dek,
          deviceUuid: deviceUuid || undefined,
          config,
          sync: { mode: "cli", persist: true },
          layoutPrefix: "accounts/local",
        });
        const devH = canonicalDevH(String(devHRaw));
        const selfDevH = deriveDevH(unlocked.dek, deviceUuid);
        const manifest = await removeManifestDevice(
          {
            adapter: store.adapter,
            dek: unlocked.dek,
            layoutPrefix: "accounts/local",
            ownerDevH: selfDevH,
            settleMs: 0,
          },
          devH,
        );
        console.log(JSON.stringify({ removed: devH, devices: manifest.devices }, null, 2));
        await store.close();
      });
    }
    throw new Error("Usage: infinitecontext storage devices remove <devH>");
  }

  throw new Error(`Unknown storage command: ${cmd}`);
}
