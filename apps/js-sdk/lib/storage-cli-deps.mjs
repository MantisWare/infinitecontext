/**
 * Optional dependency injection for storage CLI (tests only — not wired from argv/env).
 * @typedef {Object} StorageCliDeps
 * @property {(opts: { baseUrl: string }) => Promise<{ dek: Uint8Array, accountKey?: string, crypto?: Record<string, unknown>, dekVersion?: number, userPublicId?: string } | null>} [resolveUnlockedDek]
 */

/** @type {StorageCliDeps | null} */
let activeStorageCliDeps = null;

/** @param {StorageCliDeps | null} deps */
export function setStorageCliDepsForTests(deps) {
  activeStorageCliDeps = deps;
}

export function clearStorageCliDepsForTests() {
  activeStorageCliDeps = null;
}

/** @returns {StorageCliDeps | null} */
export function getStorageCliDepsForTests() {
  return activeStorageCliDeps;
}
