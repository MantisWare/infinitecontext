/**
 * Test-only keychain backend injection (not read from env).
 * @typedef {{ setPassword: (service: string, account: string, password: string) => Promise<void>, getPassword: (service: string, account: string) => Promise<string | null>, deletePassword: (service: string, account: string) => Promise<boolean> }} VaultKeychainBackend
 */

/** @type {VaultKeychainBackend | null} */
let injectedKeychainBackend = null;

/** @param {VaultKeychainBackend | null} backend */
export function setVaultKeychainBackendForTests(backend) {
  injectedKeychainBackend = backend;
}

export function clearVaultKeychainBackendForTests() {
  injectedKeychainBackend = null;
}

/** @returns {VaultKeychainBackend | null} */
export function getVaultKeychainBackendForTests() {
  return injectedKeychainBackend;
}
