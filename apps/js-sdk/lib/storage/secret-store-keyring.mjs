import { StorageError } from "./errors.mjs";
import { isLinuxSecretServiceOnSessionBus } from "./secret-store-linux-dbus.mjs";
import { platformKeychainMarkerId } from "./secret-store-marker.mjs";
import { probeKeyringSecretService } from "./secret-store-keyring-probe.mjs";
import { SECRET_STORE_SERVICE } from "./secret-store-constants.mjs";

const LINUX_ENTRY_OPTIONS = { linux: { store: "secret-service" } };

/** @returns {Promise<import('./secret-store.mjs').SecretStoreBackend>} */
export async function createKeyringSecretBackend() {
  if (process.platform === "linux") {
    if (!(await isLinuxSecretServiceOnSessionBus())) {
      throw new StorageError(
        "Linux Secret Service (org.freedesktop.secrets) is not available on the session D-Bus",
        "not_supported",
      );
    }
  }
  const { Entry } = await import("@napi-rs/keyring");
  const entryOptions = process.platform === "linux" ? LINUX_ENTRY_OPTIONS : undefined;
  const markerKind = platformKeychainMarkerId();
  if (!markerKind) {
    throw new StorageError("OS keychain is not supported on this platform", "not_supported");
  }
  return {
    kind: markerKind,
    async setSecret(name, secret) {
      const entry = new Entry(SECRET_STORE_SERVICE, name, entryOptions);
      entry.setSecret(secret);
    },
    async getSecret(name) {
      const entry = new Entry(SECRET_STORE_SERVICE, name, entryOptions);
      const bytes = entry.getSecret();
      if (!bytes || bytes.length === 0) {
        return null;
      }
      return new Uint8Array(bytes);
    },
    async deleteSecret(name) {
      const entry = new Entry(SECRET_STORE_SERVICE, name, entryOptions);
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
 * Whether `auto` may select the OS keychain backend.
 * @returns {Promise<boolean>}
 */
export async function isKeyringUsableForAuto() {
  if (!(await keyringBackendAvailable())) {
    return false;
  }
  if (!platformKeychainMarkerId()) {
    return false;
  }
  if (process.env.INFINITECONTEXT_KEYRING_DURABLE === "0") {
    return false;
  }
  return probeKeyringSecretService();
}

/**
 * @param {{ forExplicitKeyringMode?: boolean; markedBackend?: import('./secret-store-marker.mjs').SecretStoreBackendMarker }} [options]
 */
export async function assertKeyringBackendReady(options = {}) {
  const { forExplicitKeyringMode = false, markedBackend } = options;
  const localMarker = platformKeychainMarkerId();
  const markedLabel = markedBackend ?? localMarker ?? "keyring";

  if (process.platform === "linux" && !process.env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    throw keyringUnavailableError(
      forExplicitKeyringMode,
      markedLabel,
      "Session D-Bus is unavailable (DBUS_SESSION_BUS_ADDRESS). On Linux, InfiniteContext only uses Secret Service over D-Bus — not the kernel keyring.",
    );
  }

  if (!(await keyringBackendAvailable())) {
    throw keyringUnavailableError(
      forExplicitKeyringMode,
      markedLabel,
      "OS keychain module is unavailable",
    );
  }

  if (process.platform === "linux" && !(await isLinuxSecretServiceOnSessionBus())) {
    throw keyringUnavailableError(
      forExplicitKeyringMode,
      markedLabel,
      "org.freedesktop.secrets is not reachable on the session D-Bus",
    );
  }

  const ok = await probeKeyringSecretService();
  if (!ok) {
    throw keyringUnavailableError(
      forExplicitKeyringMode,
      markedLabel,
      "Secret Service is locked or did not respond to a non-interactive probe",
    );
  }
}

/**
 * @param {boolean} forExplicitKeyringMode
 * @param {string} markedLabel
 * @param {string} detail
 */
function keyringUnavailableError(forExplicitKeyringMode, markedLabel, detail) {
  if (forExplicitKeyringMode) {
    return new StorageError(
      `${detail} (INFINITECONTEXT_SECRET_STORE=keyring). Unlock the keyring or set INFINITECONTEXT_SECRET_STORE=file.`,
      "not_supported",
    );
  }
  return new StorageError(
    `storage-secrets.backend is "${markedLabel}" but ${detail.charAt(0).toLowerCase()}${detail.slice(1)}. ` +
      "Unlock Secret Service, migrate secrets to the file backend, or remove storage-secrets.backend after migrating.",
    "migration_required",
  );
}
