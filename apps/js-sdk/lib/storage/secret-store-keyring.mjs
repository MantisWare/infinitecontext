import { StorageError } from "./errors.mjs";
import { probeKeyringSecretService } from "./secret-store-keyring-probe.mjs";
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
 * Whether `auto` may select the keyring backend (Secret Service responds non-interactively).
 * @returns {Promise<boolean>}
 */
export async function isKeyringUsableForAuto() {
  if (!(await keyringBackendAvailable())) {
    return false;
  }
  if (process.env.INFINITECONTEXT_KEYRING_DURABLE === "0") {
    return false;
  }
  if (process.env.INFINITECONTEXT_KEYRING_DURABLE === "1") {
    return probeKeyringSecretService();
  }
  return probeKeyringSecretService();
}

/**
 * @param {{ forExplicitKeyringMode?: boolean }} [options]
 */
export async function assertKeyringSecretServiceReady(options = {}) {
  const { forExplicitKeyringMode = false } = options;
  if (!(await keyringBackendAvailable())) {
    throw new StorageError(
      forExplicitKeyringMode
        ? "OS keychain module is unavailable (INFINITECONTEXT_SECRET_STORE=keyring)"
        : "OS keychain is unavailable but storage-secrets.backend is set to keyring. Migrate secrets to the file backend or restore Secret Service.",
      "not_supported",
    );
  }
  const ok = await probeKeyringSecretService();
  if (!ok) {
    throw new StorageError(
      forExplicitKeyringMode
        ? "OS Secret Service is locked or did not respond (INFINITECONTEXT_SECRET_STORE=keyring). Unlock the keyring or set INFINITECONTEXT_SECRET_STORE=file."
        : "storage-secrets.backend is set to keyring but Secret Service is locked or unavailable. Unlock the keyring or migrate secrets to the file backend (remove storage-secrets.backend after migrating).",
      forExplicitKeyringMode ? "not_supported" : "migration_required",
    );
  }
}
