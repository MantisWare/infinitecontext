import { copyVerifiedStoragePutBodyForAdapter } from "./encrypt-storage-object.mjs";
import {
  confirmObjectStorePullDeliveryForContext,
  objectStoreFetchSyncConflicts,
  objectStoreFetchSyncStatus,
  objectStorePullSyncChanges,
  objectStorePushSyncMutations,
} from "../object-store-sync.mjs";
import { deriveDevH } from "./layout.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */
/** @typedef {import("./types.mjs").StoragePutOptions} StoragePutOptions */
/** @typedef {import("./types.mjs").StorageRequestOptions} StorageRequestOptions */

/**
 * @typedef {Object} ObjectStoreSyncTransportOptions
 * @property {Uint8Array} [dek] vault DEK for layout log segments (required for sync methods)
 * @property {string} [deviceUuid] canonical device UUID (required for sync methods)
 * @property {string} [layoutPrefix] object layout prefix (default `accounts/local`)
 * @property {{ load: () => import('../object-store-local-sync-state.mjs').ObjectStoreLocalSyncState, save: (s: import('../object-store-local-sync-state.mjs').ObjectStoreLocalSyncState) => void }} localState
 * @property {() => void | Promise<void>} [testHookAfterSegmentWrite] test-only crash hook
 * @property {boolean} [testHookSkipLocalSaveAfterSegmentWrite] simulate crash before local commit
 */

/**
 * Sync-facing object store: sealed vault puts plus optional encrypted log sync transport.
 */
export class ObjectStoreSyncTransport {
  /** @type {StorageAdapter} */
  #adapter;

  /** @type {ObjectStoreSyncTransportOptions | null} */
  #sync;

  /** @param {StorageAdapter} adapter @param {ObjectStoreSyncTransportOptions} [syncOptions] */
  constructor(adapter, syncOptions = null) {
    this.#adapter = adapter;
    this.#sync = syncOptions;
  }

  /** @returns {import("../object-store-sync.mjs").objectStorePushSyncMutations extends (ctx: infer C, ...args: never) => unknown ? C : never} */
  #syncContext() {
    if (!this.#sync?.dek || !this.#sync.deviceUuid || !this.#sync.localState) {
      throw new Error("ObjectStoreSyncTransport sync requires dek, deviceUuid, and localState");
    }
    const selfDevH = deriveDevH(this.#sync.dek, this.#sync.deviceUuid);
    return {
      adapter: this.#adapter,
      dek: this.#sync.dek,
      layoutPrefix: this.#sync.layoutPrefix ?? "accounts/local",
      selfDevH,
      deviceUuid: this.#sync.deviceUuid,
      localState: this.#sync.localState,
      testHookAfterSegmentWrite: this.#sync.testHookAfterSegmentWrite,
      testHookSkipLocalSaveAfterSegmentWrite: this.#sync.testHookSkipLocalSaveAfterSegmentWrite,
    };
  }

  /** @param {string} key @param {Uint8Array} sealedBody @param {StoragePutOptions} [options] */
  async putObject(key, sealedBody, options = {}) {
    const bodyForAdapter = copyVerifiedStoragePutBodyForAdapter(sealedBody);
    return this.#adapter.put(key, bodyForAdapter, options);
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

  async fetchSyncStatus() {
    return objectStoreFetchSyncStatus(this.#syncContext());
  }

  async pullSyncChanges(options = {}) {
    return objectStorePullSyncChanges(this.#syncContext(), options);
  }

  async confirmPullDelivery() {
    await confirmObjectStorePullDeliveryForContext(this.#syncContext());
  }

  /** @returns {true} */
  get usesVectorPullCursor() {
    return true;
  }

  async pushSyncMutations(mutations, _options = {}) {
    return objectStorePushSyncMutations(this.#syncContext(), mutations);
  }

  async fetchSyncConflicts(_options = {}) {
    return objectStoreFetchSyncConflicts(this.#syncContext());
  }
}
