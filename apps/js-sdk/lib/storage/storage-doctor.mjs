import { assertFolderCopyFolderDirsClean, assertFolderObjectFileCopiesClean } from "./folder-object-conflict-preflight.mjs";
import { verifyFolderDeviceLogsForManifest } from "./folder-storage-repair.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./folder-adapter.mjs";

/**
 * Read-only folder vault audit (no quarantine / repair).
 *
 * @param {{
 *   adapter: import("./types.mjs").StorageAdapter,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid?: string,
 * }} params
 */
export async function auditFolderObjectStoreVault(params) {
  const folder = /** @type {{ rootDir?: string, id?: string }} */ (params.adapter);
  if (!folder.rootDir) {
    throw new Error("storage doctor requires a folder storage adapter");
  }
  await params.adapter.init();
  /** @type {{ code: string, message: string } | null} */
  let preflightError = null;
  try {
    await assertFolderObjectFileCopiesClean(params.adapter, params.layoutPrefix);
    await assertFolderCopyFolderDirsClean(params.adapter, params.layoutPrefix);
  } catch (error) {
    preflightError = {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const manifest = await loadFolderMergedManifest(params.adapter, params.dek, params.layoutPrefix);
  /** @type {{ ok: boolean, error?: string }} */
  let logVerify = { ok: true };
  if (!preflightError) {
    try {
      const { deriveDevH } = await import("./layout.mjs");
      const selfDevH = params.deviceUuid
        ? deriveDevH(params.dek, params.deviceUuid)
        : manifest.devices[0]?.devH;
      await verifyFolderDeviceLogsForManifest(
        {
          adapter: params.adapter,
          dek: params.dek,
          layoutPrefix: params.layoutPrefix,
          selfDevH: selfDevH ?? "",
          deviceUuid: params.deviceUuid ?? "",
          localState: { load: () => ({}), save: async () => {} },
        },
        manifest,
      );
    } catch (error) {
      logVerify = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    logVerify = { ok: false, error: "skipped due to preflight failure" };
  }
  return {
    backend: folder.id ?? FOLDER_STORAGE_ADAPTER_ID,
    rootDir: folder.rootDir,
    manifest: {
      manifest_generation: manifest.manifest_generation,
      devices: manifest.devices.length,
    },
    preflight: preflightError,
    logVerify,
    ok: !preflightError && logVerify.ok,
  };
}
