import fs from "node:fs";
import path from "node:path";

import { StorageError } from "./errors.mjs";
import { writePrivateFileAtomic } from "./secret-store-file.mjs";

const MARKER_FILENAME = "storage-secrets.backend";

/** @typedef {'file' | 'keyring'} SecretStoreBackendKind */

/** @param {string} rootDir */
export function backendMarkerPath(rootDir) {
  return path.join(rootDir, MARKER_FILENAME);
}

/** @param {string} rootDir @returns {SecretStoreBackendKind | null} */
export function readBackendMarker(rootDir) {
  const markerPath = backendMarkerPath(rootDir);
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  const raw = fs.readFileSync(markerPath, "utf8").trim().toLowerCase();
  if (raw === "file" || raw === "keyring") {
    return raw;
  }
  throw new StorageError("Corrupt storage-secrets.backend marker", "corrupt_secret_store");
}

/** @param {string} rootDir @param {SecretStoreBackendKind} kind */
export function writeBackendMarker(rootDir, kind) {
  writePrivateFileAtomic(rootDir, MARKER_FILENAME, `${kind}\n`);
}

/**
 * @param {SecretStoreBackendKind} marked
 * @param {'auto' | 'keyring' | 'file'} requestedMode
 */
export function assertMarkerMatchesRequestedMode(marked, requestedMode) {
  if (requestedMode === "auto") {
    return;
  }
  if (marked !== requestedMode) {
    throw new StorageError(
      `storage-secrets.backend is set to "${marked}" but INFINITECONTEXT_SECRET_STORE=${requestedMode}. ` +
        "Use the marked backend, remove storage-secrets.backend after migrating secrets, or pick one backend consistently.",
      "migration_required",
    );
  }
}
