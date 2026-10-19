import { readConfigFile } from "./client-config.mjs";
import { FOLDER_STORAGE_ADAPTER_ID } from "./storage/folder-object-store.mjs";
import { LOCAL_OBJECT_STORE_BACKEND_ID } from "./storage/local-object-store.mjs";
import { S3_OBJECT_STORE_BACKEND_ID } from "./storage/s3-config.mjs";
import { SFTP_OBJECT_STORE_BACKEND_ID } from "./storage/sftp-config.mjs";

/** @param {Record<string, unknown>} [config] */
export function resolveStorageBackendId(config = readConfigFile()) {
  const storage = config.storage;
  if (storage && typeof storage === "object" && !Array.isArray(storage)) {
    const backend = String(/** @type {Record<string, unknown>} */ (storage).backend ?? "").trim();
    if (backend) return backend;
  }
  return "hosted";
}

/** @param {Record<string, unknown>} [config] */
export function isHostedStorageBackend(config = readConfigFile()) {
  const id = resolveStorageBackendId(config);
  return id === "hosted";
}

/** @param {Record<string, unknown>} [config] */
export function isFolderObjectStoreBackend(config = readConfigFile()) {
  return resolveStorageBackendId(config) === FOLDER_STORAGE_ADAPTER_ID;
}

/** @param {Record<string, unknown>} [config] */
export function isS3ObjectStoreBackend(config = readConfigFile()) {
  return resolveStorageBackendId(config) === S3_OBJECT_STORE_BACKEND_ID;
}

/** @param {Record<string, unknown>} [config] */
export function isSftpObjectStoreBackend(config = readConfigFile()) {
  return resolveStorageBackendId(config) === SFTP_OBJECT_STORE_BACKEND_ID;
}

export function isLocalObjectStoreBackend(config = readConfigFile()) {
  const id = resolveStorageBackendId(config);
  return (
    id === LOCAL_OBJECT_STORE_BACKEND_ID ||
    id === "local" ||
    id === "local-filesystem" ||
    id === FOLDER_STORAGE_ADAPTER_ID ||
    id === S3_OBJECT_STORE_BACKEND_ID ||
    id === SFTP_OBJECT_STORE_BACKEND_ID
  );
}
