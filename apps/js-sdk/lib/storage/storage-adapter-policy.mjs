import { STORAGE_CAPABILITIES } from "./types.mjs";

/** @param {import("./types.mjs").StorageAdapter} adapter */
export function storageAdapterHasCrossDeviceCas(adapter) {
  return adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace);
}

/** Log segment GC requires cross-device CAS (not folder / eventual sync). */
export function isObjectStoreLogGcEnabled(adapter) {
  return storageAdapterHasCrossDeviceCas(adapter);
}

/** @param {import("./types.mjs").StorageAdapter} adapter */
export function usesFolderMergedDeviceManifest(adapter) {
  return adapter?.id === "folder";
}
