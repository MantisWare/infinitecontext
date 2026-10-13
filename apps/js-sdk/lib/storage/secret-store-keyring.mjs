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
    await import("@napi-rs/keyring");
    return true;
  } catch {
    return false;
  }
}

/**
 * OS keychains that survive reboot (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 * Headless Linux often binds @napi-rs/keyring to the kernel keyring, which is cleared on reboot — not used for `auto`.
 * @returns {boolean}
 */
export function isKeyringDurableForAuto() {
  if (process.platform !== "linux") {
    return true;
  }
  if (process.env.INFINITECONTEXT_KEYRING_DURABLE === "1") {
    return true;
  }
  if (process.env.INFINITECONTEXT_KEYRING_DURABLE === "0") {
    return false;
  }
  return Boolean(process.env.DBUS_SESSION_BUS_ADDRESS?.trim());
}
