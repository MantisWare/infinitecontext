import fs from "node:fs";

import { verifyDeviceLogThroughSeq } from "../object-store-chain-verify.mjs";
import {
  createEmptyObjectStoreLocalSyncState,
} from "../object-store-local-sync-state.mjs";
import {
  createCliFileObjectStoreLocalState,
  createDaemonDbObjectStoreLocalState,
  defaultObjectStoreSyncStatePath,
} from "../object-store-local-state-persist.mjs";
import {
  manifestGenerationHighWaterForBinding,
  resolveObjectStoreTrustBindingKey,
} from "../object-store-sync-binding.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./folder-adapter.mjs";
import { mergeTrustedHeadsMonotonic } from "./storage-manifest.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";
import { logSegmentRelativePath } from "./layout.mjs";
import { StorageError } from "./errors.mjs";
import { ObjectStoreLogForkError, ObjectStoreLogRollbackError } from "../object-store-local-sync-state.mjs";

/**
 * @param {import("../object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} a
 * @param {import("../object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} b
 */
export function mergeAggregatedObjectStoreLocalTrust(a, b) {
  const out = { ...a, trustedHeads: { ...a.trustedHeads } };
  out.trustedHeads = mergeTrustedHeadsMonotonic(out.trustedHeads, b.trustedHeads ?? {});
  out.manifestGenerationHighWaterByBindingKey = {
    ...(a.manifestGenerationHighWaterByBindingKey ?? {}),
    ...(b.manifestGenerationHighWaterByBindingKey ?? {}),
  };
  for (const [key, gen] of Object.entries(b.manifestGenerationHighWaterByBindingKey ?? {})) {
    out.manifestGenerationHighWaterByBindingKey[key] = Math.max(
      out.manifestGenerationHighWaterByBindingKey[key] ?? 0,
      gen,
    );
  }
  out.manifestGenerationHighWater = Math.max(
    a.manifestGenerationHighWater ?? 0,
    b.manifestGenerationHighWater ?? 0,
  );
  return out;
}

/**
 * @param {{ cliStatePath?: string, daemonDbPath?: string }} [options]
 */
export function loadAggregatedObjectStoreLocalTrust(options = {}) {
  const cliPath = options.cliStatePath ?? defaultObjectStoreSyncStatePath();
  let merged = createEmptyObjectStoreLocalSyncState();
  if (fs.existsSync(cliPath)) {
    merged = mergeAggregatedObjectStoreLocalTrust(
      merged,
      createCliFileObjectStoreLocalState(cliPath).load(),
    );
  }
  if (options.daemonDbPath && fs.existsSync(options.daemonDbPath)) {
    const daemon = createDaemonDbObjectStoreLocalState(options.daemonDbPath);
    try {
      merged = mergeAggregatedObjectStoreLocalTrust(merged, daemon.load());
    } finally {
      daemon.close();
    }
  }
  return merged;
}

/**
 * @param {import("../object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} localTrust
 * @param {import("./storage-manifest.mjs").StorageManifest} manifest
 */
export function vaultHasTrustedHeadAnchors(localTrust, manifest) {
  for (const head of Object.values(localTrust.trustedHeads ?? {})) {
    if (head && Number.isFinite(head.seq) && head.seq >= 0) return true;
  }
  for (const head of Object.values(manifest.trusted_heads ?? {})) {
    if (head && Number.isFinite(head.seq) && head.seq >= 0) return true;
  }
  return false;
}

/**
 * @param {import("./storage-manifest.mjs").StorageManifest} manifest
 */
export function computeFolderStoreIdentity(manifest) {
  const devices = manifest.devices
    .map((row) => row.devH)
    .sort()
    .join(",");
  return `${manifest.manifest_generation}:${devices}`;
}

/**
 * @param {{
 *   manifest: import("./storage-manifest.mjs").StorageManifest,
 *   localTrust: import("../object-store-local-sync-state.mjs").ObjectStoreLocalSyncState,
 *   bindingKey: string,
 * }} params
 * @returns {{ code: string, message: string }[]}
 */
export function collectVaultTrustRollbackIssues(params) {
  /** @type {{ code: string, message: string }[]} */
  const issues = [];
  const highWater = manifestGenerationHighWaterForBinding(params.localTrust, params.bindingKey);
  if (highWater > 0 && params.manifest.manifest_generation < highWater) {
    issues.push({
      code: "log_rollback",
      message: `Manifest generation ${params.manifest.manifest_generation} is below local high-water ${highWater}`,
    });
  }
  let expected = { ...(params.localTrust.trustedHeads ?? {}) };
  expected = mergeTrustedHeadsMonotonic(expected, params.manifest.trusted_heads ?? {});
  for (const [devH, head] of Object.entries(expected)) {
    if (!head || head.seq < 0) continue;
    const row = params.manifest.devices.find((d) => d.devH === devH);
    const storeSeq = row?.last_seq ?? -1;
    if (head.seq > storeSeq) {
      issues.push({
        code: "log_rollback",
        message: `Device log for ${devH} rolled back (trusted seq ${head.seq}, store head ${storeSeq})`,
      });
    }
  }
  return issues;
}

/**
 * @param {import("../object-store-sync.mjs").ObjectStoreSyncContext} ctx
 * @param {import("./storage-manifest.mjs").StorageManifest} manifest
 * @param {import("../object-store-local-sync-state.mjs").ObjectStoreLocalSyncState} localTrust
 */
export async function verifyStoreLogsAgainstTrustedHeads(ctx, manifest, localTrust) {
  let expected = { ...(localTrust.trustedHeads ?? {}) };
  expected = mergeTrustedHeadsMonotonic(expected, manifest.trusted_heads ?? {});
  for (const row of manifest.devices) {
    const headSeq = row.last_seq ?? -1;
    if (headSeq < 0) continue;
    const devH = row.devH;
    const trustedHead = expected[devH];
    const readEnvelopeAtSeq = async (seq) => {
      const key = logSegmentRelativePath(ctx.layoutPrefix, devH, seq);
      const got = await ctx.adapter.get(key);
      if (!got?.body) return null;
      const { decryptVaultStorageObjectPlaintext } = await import("./storage-object-move.mjs");
      const plain = decryptVaultStorageObjectPlaintext(ctx.dek, key, got.body);
      return plain?.ic_layout_segment_envelope_v1 ?? null;
    };
    await verifyDeviceLogThroughSeq(ctx, devH, trustedHead, readEnvelopeAtSeq, headSeq);
  }
}

/**
 * @param {{
 *   adapter: import("./types.mjs").StorageAdapter,
 *   dek: Uint8Array,
 *   layoutPrefix: string,
 *   deviceUuid: string,
 *   storeRootDir: string,
 *   localTrust?: import("../object-store-local-sync-state.mjs").ObjectStoreLocalSyncState,
 *   cliStatePath?: string,
 *   daemonDbPath?: string,
 *   backendId?: string,
 * }} params
 */
export async function auditVaultStoreTrust(params) {
  const localTrust =
    params.localTrust ??
    loadAggregatedObjectStoreLocalTrust({
      cliStatePath: params.cliStatePath,
      daemonDbPath: params.daemonDbPath,
    });
  const backendId = params.backendId ?? FOLDER_STORAGE_ADAPTER_ID;
  const bindingKey = resolveObjectStoreTrustBindingKey(params.storeRootDir, backendId);
  const manifest = await loadFolderMergedManifest(params.adapter, params.dek, params.layoutPrefix);
  const rollbackIssues = collectVaultTrustRollbackIssues({ manifest, localTrust, bindingKey });
  if (rollbackIssues.length) {
    const first = rollbackIssues[0];
    return {
      manifest,
      logVerify: { ok: false, code: first.code, error: first.message },
      headsVerified: false,
    };
  }
  if (!vaultHasTrustedHeadAnchors(localTrust, manifest)) {
    return {
      manifest,
      logVerify: {
        ok: false,
        status: "heads_unverified",
        error: "No device-written trusted heads or local sync-state trusted heads to verify against",
      },
      headsVerified: false,
    };
  }
  const ctx = {
    adapter: params.adapter,
    dek: params.dek,
    layoutPrefix: params.layoutPrefix,
    selfDevH: "",
    deviceUuid: params.deviceUuid,
    localState: { load: () => localTrust, save: async () => {} },
  };
  try {
    await verifyStoreLogsAgainstTrustedHeads(ctx, manifest, localTrust);
    return { manifest, logVerify: { ok: true }, headsVerified: true };
  } catch (error) {
    const code =
      error instanceof ObjectStoreLogRollbackError
        ? "log_rollback"
        : error instanceof ObjectStoreLogForkError
          ? "storage_fork"
          : error instanceof StorageError
            ? error.code
            : "error";
    return {
      manifest,
      logVerify: {
        ok: false,
        code,
        error: error instanceof Error ? error.message : String(error),
      },
      headsVerified: false,
    };
  }
}

/**
 * @param {Parameters<typeof auditVaultStoreTrust>[0]} params
 */
export async function assertVaultStoreTrustOrThrow(params) {
  const result = await auditVaultStoreTrust(params);
  if (result.logVerify.ok) return result.manifest;
  const code = result.logVerify.code ?? result.logVerify.status ?? "log_rollback";
  throw new StorageError(String(result.logVerify.error), String(code));
}
