/**
 * @typedef {'get' | 'head' | 'put' | 'list' | 'delete' | 'conditionalWrite'} StorageCapability
 */

/**
 * @typedef {Object} StorageObjectRef
 * @property {string} key
 * @property {string} [etag]
 * @property {string} [revision]
 */

/**
 * @typedef {Object} StorageGetResult
 * @property {Uint8Array} body
 * @property {string} [etag]
 */

/**
 * @typedef {Object} StorageHeadResult
 * @property {string} [etag]
 * @property {number} size
 */

/**
 * @typedef {Object} StoragePutOptions
 * @property {string} [ifMatch] ETag precondition — write only when current ETag matches.
 * @property {string} [ifNoneMatch] `"*"` create-only, or match a specific ETag.
 */

/**
 * @typedef {Object} StorageDeleteOptions
 * @property {string} [ifMatch] Delete only when current ETag matches.
 */

/**
 * @typedef {Object} StorageListOptions
 * @property {number} [limit]
 * @property {string} [cursor]
 */

/**
 * @typedef {Object} StorageListResult
 * @property {StorageObjectRef[]} objects
 * @property {string} [nextCursor]
 */

/**
 * @typedef {Object} StorageAdapter
 * @property {string} id
 * @property {ReadonlySet<StorageCapability>} capabilities
 * @property {(key: string) => Promise<StorageGetResult | null>} get
 * @property {(key: string) => Promise<StorageHeadResult | null>} head
 * @property {(key: string, body: Uint8Array, options?: StoragePutOptions) => Promise<StorageObjectRef>} put
 * @property {(prefix: string, options?: StorageListOptions) => Promise<StorageListResult>} list
 * @property {(key: string, options?: StorageDeleteOptions) => Promise<void>} delete
 */

export const STORAGE_CAPABILITIES = Object.freeze({
  get: "get",
  head: "head",
  put: "put",
  list: "list",
  delete: "delete",
  conditionalWrite: "conditionalWrite",
});

/** @param {Iterable<StorageCapability>} values */
export function storageCapabilitySet(values) {
  return new Set(values);
}
