import { SECRET_STORE_SERVICE } from "./secret-store-constants.mjs";

/** @returns {Promise<import('./secret-store.mjs').SecretStoreBackend>} */
export async function createKeyringSecretBackend() {
  const { Entry } = await import("@napi-rs/keyring");
  return {
    kind: "keyring",
    async setSecret(name, secret) {
      const entry = new Entry(SECRET_STORE_SERVICE, name);
      entry.setSecret(secret);
    },
    async getSecret(name) {
      const entry = new Entry(SECRET_STORE_SERVICE, name);
      const bytes = entry.getSecret();
      if (!bytes || bytes.length === 0) {
        return null;
      }
      return new Uint8Array(bytes);
    },
    async deleteSecret(name) {
      const entry = new Entry(SECRET_STORE_SERVICE, name);
      return entry.deleteCredential();
    },
  };
}

/** @returns {Promise<boolean>} */
export async function keyringBackendAvailable() {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const probeName = `__ic_keyring_probe_${process.pid}_${Date.now()}`;
    const entry = new Entry(SECRET_STORE_SERVICE, probeName);
    entry.setSecret(new Uint8Array([0x1c]));
    entry.deleteCredential();
    return true;
  } catch {
    return false;
  }
}
