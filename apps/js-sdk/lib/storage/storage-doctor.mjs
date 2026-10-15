import { assertFolderCopyFolderDirsClean, assertFolderObjectFileCopiesClean } from "./folder-object-conflict-preflight.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./folder-adapter.mjs";
import { auditVaultStoreTrust } from "./storage-vault-trust-audit.mjs";

/**
 * Read-only folder vault audit (no quarantine / repair).
 *
 * @param {{
 *   adapter: import("./types.mjs").StorageAdapter,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid?: string,
 *   cliStatePath?: string,
 *   daemonDbPath?: string,
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
    await assertFolderObjectFileCopiesClean(params.adapter, params.layoutPrefix, {
      includeManifest: true,
    });
    await assertFolderCopyFolderDirsClean(params.adapter, params.layoutPrefix);
  } catch (error) {
    preflightError = {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const manifest = await loadFolderMergedManifest(params.adapter, params.dek, params.layoutPrefix);
  /** @type {{ ok: boolean, code?: string, status?: string, error?: string }} */
  let logVerify = { ok: true };
  if (!preflightError) {
    const trust = await auditVaultStoreTrust({
      adapter: params.adapter,
      dek: params.dek,
      layoutPrefix: params.layoutPrefix,
      deviceUuid: params.deviceUuid ?? "",
      storeRootDir: folder.rootDir,
      cliStatePath: params.cliStatePath,
      daemonDbPath: params.daemonDbPath,
      backendId: FOLDER_STORAGE_ADAPTER_ID,
    });
    logVerify = trust.logVerify;
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
