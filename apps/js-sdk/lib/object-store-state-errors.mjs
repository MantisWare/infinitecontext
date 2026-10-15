export class ObjectStoreSyncStateError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "object_store_sync_state") {
    super(message);
    this.name = "ObjectStoreSyncStateError";
    this.code = code;
  }
}
