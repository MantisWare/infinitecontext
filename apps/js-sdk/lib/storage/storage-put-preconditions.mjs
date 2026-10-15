import { NotSupportedError } from "./errors.mjs";
import { STORAGE_CAPABILITIES } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */
/** @typedef {import("./types.mjs").StoragePutOptions} StoragePutOptions */
/** @typedef {import("./types.mjs").StorageDeleteOptions} StorageDeleteOptions */

/**
 * @param {StorageAdapter} adapter
 * @param {StoragePutOptions} [putOptions]
 */
export function assertStoragePutPreconditionsSupported(adapter, putOptions = {}) {
  if (
    putOptions.ifMatch !== undefined &&
    !adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace)
  ) {
    throw new NotSupportedError("Storage backend does not support conditional replace (If-Match)");
  }
  if (
    putOptions.ifNoneMatch !== undefined &&
    !adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalCreate)
  ) {
    throw new NotSupportedError("Storage backend does not support conditional create (If-None-Match)");
  }
}

/**
 * @param {StorageAdapter} adapter
 * @param {StorageDeleteOptions} [deleteOptions]
 */
export function assertStorageDeletePreconditionsSupported(adapter, deleteOptions = {}) {
  if (
    deleteOptions.ifMatch !== undefined &&
    !adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace)
  ) {
    throw new NotSupportedError("Storage backend does not support conditional delete (If-Match)");
  }
}
