import { STORAGE_CAPABILITIES } from "./types.mjs";

/** @param {import("./types.mjs").StorageAdapter} adapter */
export function storageAdapterHasCrossDeviceCas(adapter) {
  return adapter.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas);
}

/** Log segment GC requires cross-device CAS. */
export function isObjectStoreLogGcEnabled(adapter) {
  return storageAdapterHasCrossDeviceCas(adapter);
}

/** Snapshot write + compaction require cross-device CAS. */
export function isObjectStoreCompactionEnabled(adapter) {
  return storageAdapterHasCrossDeviceCas(adapter);
}

/** Shared manifest.json.enc (CAS/lease) vs per-device merged contributions. */
export function usesSharedStorageManifest(adapter) {
  return storageAdapterHasCrossDeviceCas(adapter);
}

/** @param {import("./types.mjs").StorageAdapter} adapter */
export function usesFolderMergedDeviceManifest(adapter) {
  return !usesSharedStorageManifest(adapter);
}

/** Folder / eventual-sync backends never read or write snap/ objects. */
export function storageAdapterIgnoresSnapshotObjects(adapter) {
  return !storageAdapterHasCrossDeviceCas(adapter);
}
