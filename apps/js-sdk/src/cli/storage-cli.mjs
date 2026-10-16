import process from "node:process";

import { getUnlockedDek } from "../../lib/vault-session.mjs";
import { readConfigFile, resolveBaseUrl } from "../../lib/client-config.mjs";
import {
  configureObjectStoreSyncTransportIfNeeded,
  resetObjectStoreBootstrapForTests,
} from "../../lib/sync-object-store-bootstrap.mjs";
import { createLocalObjectStore } from "../../lib/storage/local-object-store.mjs";
import { isHostedStorageBackend, isS3ObjectStoreBackend } from "../../lib/sync-storage-backend.mjs";
import {
  isManifestDeviceRecentlyActive,
  loadStorageManifest,
  removeManifestDevice,
} from "../../lib/storage/storage-manifest.mjs";
import { canonicalDevH, deriveDevH } from "../../lib/storage/layout.mjs";
import { formatSyncCliError } from "../../lib/sync-errors.mjs";
import { getStorageCliDepsForTests } from "../../lib/storage-cli-deps.mjs";
import { defaultObjectStoreSyncStatePath } from "../../lib/object-store-local-state-persist.mjs";

/**
 * @param {string | undefined} subcommand
 * @param {string[]} args
 * @param {import("../../lib/storage-cli-deps.mjs").StorageCliDeps} [deps]
 */
export async function runStorageCli(subcommand, args, deps = getStorageCliDepsForTests() ?? undefined) {
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
  init <folderPath>                 Create folder store skeleton (objects/)
  doctor [--repair] [--dry-run]     Audit folder vault; optional quarantine repair
  doctor --cas-race[=N]             S3 only: optional conditional-write race probe (default 20 rounds)
  doctor --recheck-cas              S3 only: rerun basic CAS probe and clear cas_unsafe when it passes
  doctor --reset-cas-cache          S3 only: fresh corruption marker; preserve unsafe flags; drop last-good
  migrate [--to <folder>] [--apply-config] [--reset]  Resumable local → folder copy + trust verify
  devices remove <devH> [--force]   Drop a device from manifest GC participation

Environment:
  Same as sync (local object store requires vault unlock)
`);
    return;
  }

  if (cmd === "init") {
    const folderPath = args[0];
    if (!folderPath) throw new Error("Usage: infinitecontext storage init <folderPath>");
    return run(async () => {
      const { initFolderStorageRoot } = await import("../../lib/storage/storage-init.mjs");
      const result = initFolderStorageRoot(folderPath);
      console.log(JSON.stringify(result, null, 2));
    });
  }

  if (cmd === "migrate") {
    const applyConfig = args.includes("--apply-config");
    const reset = args.includes("--reset");
    return run(async () => {
      const config = readConfigFile();
      if (isHostedStorageBackend(config)) {
        throw new Error("storage migrate requires local object store sync");
      }
      const resolveUnlockedDek = deps?.resolveUnlockedDek ?? ((opts) => getUnlockedDek(opts));
      const unlocked = await resolveUnlockedDek({ baseUrl });
      if (!unlocked?.dek) throw new Error("Vault unlock required");
      const storage = config.storage;
      const deviceUuid =
        storage && typeof storage === "object" && !Array.isArray(storage)
          ? String(/** @type {Record<string, unknown>} */ (storage).deviceUuid ?? "")
          : "";
      const path = await import("node:path");
      const { resolveLocalObjectStoreRootDir } = await import("../../lib/storage/local-object-store.mjs");
      const { resolveFolderObjectStoreRootDir } = await import("../../lib/storage/folder-object-store.mjs");
      const sourceRoot = resolveLocalObjectStoreRootDir({ config });
      const toIdx = args.indexOf("--to");
      const destRoot =
        toIdx >= 0 && args[toIdx + 1]
          ? path.resolve(String(args[toIdx + 1]))
          : resolveFolderObjectStoreRootDir(config);
      const { runStorageMigrateLocalToFolder, resetStorageMigrate } = await import(
        "../../lib/storage/storage-migrate-local-folder.mjs"
      );
      const scopeKey = `cli:${sourceRoot}:${destRoot}`;
      const cliStatePath = defaultObjectStoreSyncStatePath();
      if (reset) {
        const cleared = resetStorageMigrate(scopeKey, {
          config,
          layoutPrefix: "accounts/local",
          env: process.env,
        });
        console.log(JSON.stringify({ reset: true, ...cleared }, null, 2));
        return;
      }
      const result = await runStorageMigrateLocalToFolder({
        scopeKey,
        dek: unlocked.dek,
        layoutPrefix: "accounts/local",
        sourceRoot,
        destRoot,
        deviceUuid,
        applyConfig,
        cliStatePath,
      });
      console.log(JSON.stringify(result, null, 2));
    });
  }

  if (cmd === "doctor") {
    const casRaceArg = args.find((a) => a === "--cas-race" || a.startsWith("--cas-race="));
    const recheckCas = args.includes("--recheck-cas");
    const resetCasCache = args.includes("--reset-cas-cache");
    if (casRaceArg || recheckCas || resetCasCache) {
      return run(async () => {
        const config = readConfigFile();
        if (!isS3ObjectStoreBackend(config)) {
          throw new Error("storage doctor S3 CAS commands require storage.backend=s3");
        }
        const casCmdCount = [casRaceArg, recheckCas, resetCasCache].filter(Boolean).length;
        if (casCmdCount > 1) {
          throw new Error("Use only one of --cas-race, --recheck-cas, or --reset-cas-cache");
        }
        if (resetCasCache) {
          const { runStorageDoctorResetCasCache } = await import("../../lib/storage/storage-doctor-cas.mjs");
          console.log(JSON.stringify(runStorageDoctorResetCasCache({ env: process.env }), null, 2));
          return;
        }
        if (casRaceArg) {
          let rounds = 20;
          if (casRaceArg.includes("=")) {
            const parsed = Number(casRaceArg.split("=", 2)[1]);
            if (Number.isFinite(parsed) && parsed > 0) rounds = parsed;
          }
          const { runStorageDoctorCasRace } = await import("../../lib/storage/storage-doctor-cas.mjs");
          const result = await runStorageDoctorCasRace({ config, env: process.env, rounds });
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const { runStorageDoctorRecheckCas } = await import("../../lib/storage/storage-doctor-cas.mjs");
        const result = await runStorageDoctorRecheckCas({ config, env: process.env });
        console.log(JSON.stringify(result, null, 2));
      });
    }
    const action = String(args[0] ?? "").toLowerCase();
    if (action === "--repair" || action === "repair") {
      const dryRun = args.includes("--dry-run");
      return run(async () => {
        const config = readConfigFile();
        if (isHostedStorageBackend(config)) {
          throw new Error("storage doctor --repair requires local object store sync");
        }
        const resolveUnlockedDek = deps?.resolveUnlockedDek ?? ((opts) => getUnlockedDek(opts));
        await configureObjectStoreSyncTransportIfNeeded({
          mode: "cli",
          baseUrl,
          resolveUnlockedDek,
        });
        const unlocked = await resolveUnlockedDek({ baseUrl });
        if (!unlocked?.dek) throw new Error("Vault unlock required");
        const storage = config.storage;
        const backend =
          storage && typeof storage === "object" && !Array.isArray(storage)
            ? String(/** @type {Record<string, unknown>} */ (storage).backend ?? "")
            : "";
        if (backend !== "folder") {
          throw new Error("storage doctor --repair requires storage.backend=folder");
        }
        const { createFolderObjectStore } = await import("../../lib/storage/folder-object-store.mjs");
        const deviceUuid =
          storage && typeof storage === "object" && !Array.isArray(storage)
            ? String(/** @type {Record<string, unknown>} */ (storage).deviceUuid ?? "")
            : "";
        const store = await createFolderObjectStore({
          dek: unlocked.dek,
          deviceUuid: deviceUuid || undefined,
          config,
          sync: { mode: "cli", persist: true },
          layoutPrefix: "accounts/local",
        });
        const { repairFolderObjectStoreVault } = await import("../../lib/storage/folder-storage-repair.mjs");
        const { deriveDevH } = await import("../../lib/storage/layout.mjs");
        const ctx = {
          adapter: store.adapter,
          dek: unlocked.dek,
          layoutPrefix: "accounts/local",
          selfDevH: deriveDevH(unlocked.dek, deviceUuid),
          deviceUuid,
          localState: store.localState,
        };
        const result = await repairFolderObjectStoreVault(ctx, { dryRun });
        console.log(JSON.stringify(result, null, 2));
        await store.close();
        await resetObjectStoreBootstrapForTests();
      });
    }
    return run(async () => {
      const config = readConfigFile();
      if (isHostedStorageBackend(config)) {
        throw new Error("storage doctor requires local object store sync");
      }
      const resolveUnlockedDek = deps?.resolveUnlockedDek ?? ((opts) => getUnlockedDek(opts));
      const unlocked = await resolveUnlockedDek({ baseUrl });
      if (!unlocked?.dek) throw new Error("Vault unlock required");
      const storage = config.storage;
      const backend =
        storage && typeof storage === "object" && !Array.isArray(storage)
          ? String(/** @type {Record<string, unknown>} */ (storage).backend ?? "")
          : "";
      if (backend !== "folder") {
        throw new Error("storage doctor audit requires storage.backend=folder");
      }
      const deviceUuid =
        storage && typeof storage === "object" && !Array.isArray(storage)
          ? String(/** @type {Record<string, unknown>} */ (storage).deviceUuid ?? "")
          : "";
      const { resolveFolderObjectStoreRootDir } = await import(
        "../../lib/storage/folder-object-store.mjs"
      );
      const { createFolderStorageAdapter } = await import("../../lib/storage/folder-adapter.mjs");
      const rootDir = resolveFolderObjectStoreRootDir(config);
      const adapter = createFolderStorageAdapter({ rootDir, auditReadOnly: true });
      const { auditFolderObjectStoreVault } = await import("../../lib/storage/storage-doctor.mjs");
      const report = await auditFolderObjectStoreVault({
        adapter,
        dek: unlocked.dek,
        layoutPrefix: "accounts/local",
        deviceUuid,
        cliStatePath: defaultObjectStoreSyncStatePath(),
      });
      console.log(JSON.stringify(report, null, 2));
      await adapter.close();
    });
  }

  if (cmd === "devices") {
    const action = String(args[0] ?? "help").toLowerCase();
    if (action === "remove") {
      const devHRaw = args[1];
      const force = args.includes("--force");
      if (!devHRaw) throw new Error("Usage: infinitecontext storage devices remove <devH> [--force]");
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
        if (devH === selfDevH) {
          throw new Error("Cannot remove the local device from manifest participation");
        }
        const manifestBefore = await loadStorageManifest(store.adapter, unlocked.dek, "accounts/local");
        const target = manifestBefore.devices.find((row) => row.devH === devH);
        if (!target) {
          throw new Error(`Device ${devH} is not registered in the storage manifest`);
        }
        if (isManifestDeviceRecentlyActive(target) && !force) {
          throw new Error(
            "Device was active within the last 7 days; re-run with --force to remove",
          );
        }
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
