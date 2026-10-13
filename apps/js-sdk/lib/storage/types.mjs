/**
 * @typedef {'get' | 'head' | 'put' | 'list' | 'delete' | 'conditionalCreate' | 'conditionalReplace' | 'atomicRename' | 'strongListAfterWrite' | 'serverSideTimestamps'} StorageCapability
 */

/**
 * @typedef {Object} StorageObjectInfo
 * @property {string} key
 * @property {string} [etag]
 * @property {string} [revision]
 * @property {number} size
 * @property {string} [modifiedAt]
 */

/**
 * @typedef {Object} StorageGetResult
 * @property {Uint8Array} body
 * @property {string} [etag]
 * @property {number} [size]
 */

/**
 * @typedef {Object} StorageHeadResult
 * @property {string} [etag]
 * @property {number} size
 */

/**
 * @typedef {Object} StorageRequestOptions
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {StorageRequestOptions & Object} StoragePutOptions
 * @property {string} [ifMatch]
 * @property {string} [ifNoneMatch]
 */

/**
 * @typedef {StorageRequestOptions & Object} StorageDeleteOptions
 * @property {string} [ifMatch]
 */

/**
 * @typedef {StorageRequestOptions & Object} StorageListOptions
 * @property {number} [limit]
 * @property {string} [cursor] Last key from prior page (exclusive startAfter).
 */

/**
 * @typedef {Object} StorageListResult
 * @property {StorageObjectInfo[]} objects
 * @property {string} [nextCursor]
 */

/**
 * @typedef {Object} StorageRenameOptions
 * @property {string} [ifMatch]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} StorageAdapter
 * @property {string} id
 * @property {ReadonlySet<StorageCapability>} capabilities
 * @property {number} [maxObjectBytes]
 * @property {boolean} [serverSideTimestamps]
 * @property {() => Promise<void>} init
 * @property {() => Promise<void>} close
 * @property {(key: string, options?: StorageRequestOptions) => Promise<StorageGetResult | null>} get
 * @property {(key: string, options?: StorageRequestOptions) => Promise<StorageHeadResult | null>} head
 * @property {(key: string, body: Uint8Array, options?: StoragePutOptions) => Promise<StorageObjectInfo>} put
 * @property {(prefix: string, options?: StorageListOptions) => Promise<StorageListResult>} list
 * @property {(key: string, options?: StorageDeleteOptions) => Promise<void>} delete
 * @property {(fromKey: string, toKey: string, options?: StorageRenameOptions) => Promise<StorageObjectInfo>} [rename]
 */

export const STORAGE_CAPABILITIES = Object.freeze({
  get: "get",
  head: "head",
  put: "put",
  list: "list",
  delete: "delete",
  conditionalCreate: "conditionalCreate",
  conditionalReplace: "conditionalReplace",
  atomicRename: "atomicRename",
  strongListAfterWrite: "strongListAfterWrite",
  serverSideTimestamps: "serverSideTimestamps",
});

/** @param {Iterable<StorageCapability>} values */
export function storageCapabilitySet(values) {
  return new Set(values);
}

/** @param {AbortSignal | undefined} signal */
export function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
