import { assertStoragePutBodySealed } from "./encrypt-storage-object.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */
/** @typedef {import("./types.mjs").StoragePutOptions} StoragePutOptions */
/** @typedef {import("./types.mjs").StorageRequestOptions} StorageRequestOptions */

/**
 * Sync-facing object store: putObject() accepts only bodies sealed by encryptVaultPlaintextForStoragePut.
 */
export class ObjectStoreSyncTransport {
  /** @type {StorageAdapter} */
  #adapter;

  /** @param {StorageAdapter} adapter */
  constructor(adapter) {
    this.#adapter = adapter;
  }

  /** @param {string} key @param {Uint8Array} sealedBody @param {StoragePutOptions} [options] */
  async putObject(key, sealedBody, options = {}) {
    assertStoragePutBodySealed(sealedBody);
    return this.#adapter.put(key, sealedBody, options);
  }

  /** @param {string} key @param {StorageRequestOptions} [options] */
  getObject(key, options = {}) {
    return this.#adapter.get(key, options);
  }

  /** @param {string} key @param {StorageRequestOptions} [options] */
  headObject(key, options = {}) {
    return this.#adapter.head(key, options);
  }

  /** @param {string} prefix @param {import("./types.mjs").StorageListOptions} [options] */
  listObjects(prefix, options = {}) {
    return this.#adapter.list(prefix, options);
  }

  /** @param {string} key @param {import("./types.mjs").StorageDeleteOptions} [options] */
  deleteObject(key, options = {}) {
    return this.#adapter.delete(key, options);
  }
}
