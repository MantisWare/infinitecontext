import {
  loadStorageManifest,
  parseStorageManifestPlain,
  wrapStorageManifestPlain,
} from "./storage-manifest.mjs";
import { resolveObjectStoreTrustBindingKey } from "../object-store-sync-binding.mjs";
import { devHForObjectKey, layoutRootPath } from "./layout.mjs";
import { usesSharedStorageManifest } from "./storage-adapter-policy.mjs";

export { resolveObjectStoreTrustBindingKey };

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 * @param {string} devH
 */
async function highestLogSeqOnStore(adapter, layoutPrefix, devH) {
  const listPrefix = `${layoutRootPath(layoutPrefix)}/log/${devHForObjectKey(devH)}/`;
  let maxSeq = -1;
  const page = await adapter.list(listPrefix, { limit: 10_000 });
  for (const listed of page.objects ?? []) {
    const match = String(listed.key ?? "").match(/\/(\d{12})\.enc$/i);
    if (match) {
      maxSeq = Math.max(maxSeq, Number.parseInt(match[1], 10));
    }
  }
  return maxSeq;
}

/**
 * CAS manifest device rows can lag behind written log segments; trust audit uses on-disk log heads.
 *
 * @param {import("./storage-manifest.mjs").StorageManifest} manifest
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 */
export async function enrichCasManifestDeviceHeadsFromStoreListing(adapter, layoutPrefix, manifest) {
  if (!usesSharedStorageManifest(adapter)) {
    return manifest;
  }
  const next = parseStorageManifestPlain(wrapStorageManifestPlain(manifest));
  const devHs = new Set(next.devices.map((row) => row.devH));
  for (const devH of devHs) {
    const maxSeq = await highestLogSeqOnStore(adapter, layoutPrefix, devH);
    if (maxSeq < 0) continue;
    const row = next.devices.find((d) => d.devH === devH);
    if (row) {
      row.last_seq = Math.max(row.last_seq ?? -1, maxSeq);
    }
  }
  return next;
}

/**
 * Manifest for vault trust / high-water audit (CAS manifest on local; merged on folder).
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 */
export async function loadVaultTrustStoreManifest(adapter, dek, layoutPrefix) {
  const manifest = await loadStorageManifest(adapter, dek, layoutPrefix);
  return enrichCasManifestDeviceHeadsFromStoreListing(adapter, layoutPrefix, manifest);
}
