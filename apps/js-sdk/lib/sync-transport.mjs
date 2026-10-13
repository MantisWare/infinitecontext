/**
 * @typedef {Object} SyncTransport
 * @property {(options?: { baseUrl?: string }) => Promise<unknown>} fetchSyncStatus
 * @property {(options?: { since?: number, limit?: number, baseUrl?: string }) => Promise<unknown>} pullSyncChanges
 * @property {(mutations: unknown[], options?: { baseUrl?: string }) => Promise<unknown>} pushSyncMutations
 * @property {(options?: { since?: number, limit?: number, baseUrl?: string }) => Promise<unknown>} fetchSyncConflicts
 */

/** @type {SyncTransport | null} */
let defaultSyncTransport = null;

/** @param {SyncTransport} transport */
export function setDefaultSyncTransport(transport) {
  defaultSyncTransport = transport;
}

/** @returns {SyncTransport} */
export function getDefaultSyncTransport() {
  if (!defaultSyncTransport) {
    throw new Error("Sync transport not configured");
  }
  return defaultSyncTransport;
}
