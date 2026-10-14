export {
  assertStorageCiphertext,
  assertStorageAadMatchesKey,
  assertXc20pCtLength,
  buildStorageAadForKey,
  buildStorageObjectBytes,
  isValidStorageAad,
  normalizeStorageObjectKey,
  parseStorageObject,
  scanStorageObjectForLeaks,
  verifyStorageObjectForKey,
  STORAGE_OBJECT_VERSION,
  XC20P_POLY1305_TAG_BYTES,
} from "./ciphertext.mjs";
export { encryptVaultPlaintextForStoragePut } from "./encrypt-storage-object.mjs";
export { SECRET_STORE_SERVICE } from "./secret-store-constants.mjs";
export { createFilesystemStorageAdapter } from "./filesystem-adapter.mjs";
export {
  LOCAL_OBJECT_STORE_BACKEND_ID,
  createLocalObjectStore,
  defaultLocalObjectStoreRootDir,
  resolveLocalObjectStoreRootDir,
} from "./local-object-store.mjs";
export {
  IC_LAYOUT_DIR,
  IC_LAYOUT_LOG_AAD_VERSION,
  IC_VAULT_JSON_VERSION,
  LayoutIntegrityError,
  LayoutPaddingError,
  buildLayoutLogSegmentAad,
  buildVaultJsonWithWrappedDek,
  decodeVaultJson,
  deriveDevH,
  deriveNamingKey,
  deviceEncRelativePath,
  decryptLogSegment,
  encryptLogSegment,
  encodeVaultJson,
  layoutRootPath,
  layoutSegmentEnvelopeDigest,
  lockRelativePath,
  logSegmentRelativePath,
  manifestEncRelativePath,
  normalizeDeviceUuid,
  snapEncRelativePath,
  vaultJsonRelativePath,
  verifyLogSegmentChain,
} from "./layout.mjs";
export {
  decryptVaultStorageObjectPlaintext,
  moveStorageObjectWithDek,
} from "./storage-object-move.mjs";
export { SecretStore, resolveSecretStoreBackend } from "./secret-store.mjs";
export { ObjectStoreSyncTransport } from "./object-store-sync-transport.mjs";
export {
  AuthExpiredError,
  NotSupportedError,
  PreconditionFailedError,
  RateLimitedError,
  StorageError,
} from "./errors.mjs";
export { STORAGE_CAPABILITIES, storageCapabilitySet } from "./types.mjs";
