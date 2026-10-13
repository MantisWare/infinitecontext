import { infinitecontextHome } from "../client-config.mjs";
import { StorageError } from "./errors.mjs";
import { createEncryptedFileSecretBackend, fileBackendHasPersistedStore } from "./secret-store-file.mjs";
import {
  assertKeyringSecretServiceReady,
  createKeyringSecretBackend,
  isKeyringUsableForAuto,
} from "./secret-store-keyring.mjs";
import {
  assertMarkerMatchesRequestedMode,
  readBackendMarker,
  writeBackendMarker,
} from "./secret-store-marker.mjs";

export { SECRET_STORE_SERVICE } from "./secret-store-constants.mjs";

/** @typedef {'auto' | 'keyring' | 'file'} SecretStoreBackendMode */

/**
 * @typedef {Object} SecretStoreBackend
 * @property {'keyring' | 'file'} kind
 * @property {(name: string, secret: Uint8Array) => Promise<void>} setSecret
 * @property {(name: string) => Promise<Uint8Array | null>} getSecret
 * @property {(name: string) => Promise<boolean>} deleteSecret
 */

/**
 * @typedef {Object} SecretStoreOptions
 * @property {SecretStoreBackendMode} [mode]
 * @property {string} [rootDir]
 * @property {SecretStoreBackend} [backend]
 */

/**
 * @param {SecretStoreOptions} [options]
 * @returns {Promise<SecretStoreBackend>}
 */
export async function resolveSecretStoreBackend(options = {}) {
  if (options.backend) {
    return options.backend;
  }
  const mode = options.mode ?? readSecretStoreModeFromEnv();
  const rootDir = options.rootDir ?? infinitecontextHome();

  const marked = readBackendMarker(rootDir);
  if (marked) {
    assertMarkerMatchesRequestedMode(marked, mode);
    if (marked === "file") {
      return createEncryptedFileSecretBackend({ rootDir });
    }
    await assertKeyringSecretServiceReady({ forExplicitKeyringMode: mode === "keyring" });
    return createKeyringSecretBackend();
  }

  if (mode === "file") {
    const backend = createEncryptedFileSecretBackend({ rootDir });
    writeBackendMarker(rootDir, "file");
    return backend;
  }
  if (mode === "keyring") {
    await assertKeyringSecretServiceReady({ forExplicitKeyringMode: true });
    const backend = await createKeyringSecretBackend();
    writeBackendMarker(rootDir, "keyring");
    return backend;
  }

  const backend = await resolveAutoSecretStoreBackend(rootDir);
  writeBackendMarker(rootDir, backend.kind);
  return backend;
}

/**
 * @param {string} rootDir
 * @returns {Promise<SecretStoreBackend>}
 */
async function resolveAutoSecretStoreBackend(rootDir) {
  if (fileBackendHasPersistedStore(rootDir)) {
    return createEncryptedFileSecretBackend({ rootDir });
  }

  if (await isKeyringUsableForAuto()) {
    return createKeyringSecretBackend();
  }

  return createEncryptedFileSecretBackend({ rootDir });
}

/** @returns {SecretStoreBackendMode} */
export function readSecretStoreModeFromEnv() {
  const raw = String(process.env.INFINITECONTEXT_SECRET_STORE ?? "auto").trim().toLowerCase();
  if (raw === "keyring" || raw === "file" || raw === "auto") {
    return raw;
  }
  throw new StorageError(
    `Invalid INFINITECONTEXT_SECRET_STORE="${raw}" (expected auto, keyring, or file)`,
    "invalid_argument",
  );
}

export class SecretStore {
  /** @type {SecretStoreBackend | null} */
  #backend = null;

  /** @param {SecretStoreOptions} [options] */
  constructor(options = {}) {
    this.#options = options;
  }

  /** @type {SecretStoreOptions} */
  #options;

  async #ensureBackend() {
    if (!this.#backend) {
      this.#backend = await resolveSecretStoreBackend(this.#options);
    }
    return this.#backend;
  }

  /** @returns {Promise<'keyring' | 'file'>} */
  async backendKind() {
    return (await this.#ensureBackend()).kind;
  }

  /** @param {string} name @param {Uint8Array} secret */
  async set(name, secret) {
    assertSecretName(name);
    assertSecretBytes(secret);
    const backend = await this.#ensureBackend();
    await backend.setSecret(name, new Uint8Array(secret));
  }

  /** @param {string} name */
  async get(name) {
    assertSecretName(name);
    const backend = await this.#ensureBackend();
    const value = await backend.getSecret(name);
    return value ? new Uint8Array(value) : null;
  }

  /** @param {string} name */
  async delete(name) {
    assertSecretName(name);
    const backend = await this.#ensureBackend();
    return backend.deleteSecret(name);
  }
}

/** @param {string} name */
function assertSecretName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(name)) {
    throw new StorageError("Invalid secret name", "invalid_argument");
  }
}

/** @param {Uint8Array} secret */
function assertSecretBytes(secret) {
  if (!(secret instanceof Uint8Array) || secret.length === 0) {
    throw new StorageError("Secret must be a non-empty Uint8Array", "invalid_argument");
  }
}
