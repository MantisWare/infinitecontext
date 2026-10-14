import fs from "node:fs";
import path from "node:path";

import { StorageError } from "./errors.mjs";
import { writePrivateFileAtomic } from "./secret-store-file.mjs";

const MARKER_FILENAME = "storage-secrets.backend";

/** @typedef {'file' | 'secret-service' | 'macos-keychain' | 'windows-credential'} SecretStoreBackendMarker} */

const VALID_MARKERS = new Set(["file", "secret-service", "macos-keychain", "windows-credential"]);

/** @returns {SecretStoreBackendMarker | null} */
export function platformKeychainMarkerId() {
  if (process.platform === "linux") {
    return "secret-service";
  }
  if (process.platform === "darwin") {
    return "macos-keychain";
  }
  if (process.platform === "win32") {
    return "windows-credential";
  }
  return null;
}

/** @param {string} rootDir */
export function backendMarkerPath(rootDir) {
  return path.join(rootDir, MARKER_FILENAME);
}

/**
 * @param {string} raw
 * @returns {SecretStoreBackendMarker | null}
 */
function normalizeMarkerRaw(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "keyring") {
    return platformKeychainMarkerId();
  }
  if (VALID_MARKERS.has(trimmed)) {
    return /** @type {SecretStoreBackendMarker} */ (trimmed);
  }
  return null;
}

/** @param {string} rootDir @returns {SecretStoreBackendMarker | null} */
export function readBackendMarker(rootDir) {
  const markerPath = backendMarkerPath(rootDir);
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  const raw = fs.readFileSync(markerPath, "utf8");
  const normalized = normalizeMarkerRaw(raw);
  if (!normalized) {
    throw new StorageError("Corrupt storage-secrets.backend marker", "corrupt_secret_store");
  }
  return normalized;
}

/** @param {string} rootDir @param {SecretStoreBackendMarker} kind */
export function writeBackendMarker(rootDir, kind) {
  writePrivateFileAtomic(rootDir, MARKER_FILENAME, `${kind}\n`);
}

/**
 * @param {SecretStoreBackendMarker} marked
 * @param {'auto' | 'keyring' | 'file'} requestedMode
 */
export function assertMarkerMatchesRequestedMode(marked, requestedMode) {
  if (requestedMode === "auto") {
    return;
  }
  if (requestedMode === "file") {
    if (marked !== "file") {
      throw markerModeMismatchError(marked, requestedMode);
    }
    return;
  }
  const expected = platformKeychainMarkerId();
  if (!expected || marked !== expected) {
    throw markerModeMismatchError(marked, requestedMode);
  }
}

/** @param {SecretStoreBackendMarker} marked */
export function assertMarkedBackendAvailableOnPlatform(marked) {
  if (marked === "file") {
    return;
  }
  const localKeychain = platformKeychainMarkerId();
  if (!localKeychain) {
    throw new StorageError(
      `storage-secrets.backend is "${marked}" but this platform has no OS keychain backend. Migrate to file or use a supported OS.`,
      "migration_required",
    );
  }
  if (marked !== localKeychain) {
    const hint =
      marked === "secret-service"
        ? "Linux Secret Service (D-Bus)"
        : marked === "macos-keychain"
          ? "macOS Keychain"
          : marked === "windows-credential"
            ? "Windows Credential Manager"
            : marked;
    throw new StorageError(
      `storage-secrets.backend is "${marked}" (${hint}) but this machine expects "${localKeychain}". Migrate secrets and update the marker.`,
      "migration_required",
    );
  }
}

/**
 * @param {SecretStoreBackendMarker} marked
 * @param {'auto' | 'keyring' | 'file'} requestedMode
 */
function markerModeMismatchError(marked, requestedMode) {
  return new StorageError(
    `storage-secrets.backend is set to "${marked}" but INFINITECONTEXT_SECRET_STORE=${requestedMode}. ` +
      "Use the marked backend, remove storage-secrets.backend after migrating secrets, or pick one backend consistently.",
    "migration_required",
  );
}
