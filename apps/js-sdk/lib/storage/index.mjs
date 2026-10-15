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
  acquireLeaseLock,
  isLeaseLockHeldBy,
  isLeaseLockStale,
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_DEFAULT_SETTLE_MS,
  LEASE_LOCK_TTL_MS,
  releaseLeaseLock,
  renewLeaseLock,
  withLeaseLock,
} from "./lease-lock.mjs";
export {
  readLayoutObjectPlaintext,
  sealLayoutObjectPlaintext,
  storageConditionalCreate,
  storageReadModifyWrite,
} from "./storage-cas-rmw.mjs";
export {
  createEmptyStorageManifest,
  loadStorageManifest,
  MANIFEST_FORMAT,
  parseStorageManifestPlain,
  updateStorageManifest,
} from "./storage-manifest.mjs";
export {
  bootstrapLocalStateFromLatestSnapshot,
  compactObjectStoreReplica,
  gcLogSegmentsCoveredByCompaction,
  listSnapshotEpochs,
  loadStorageSnapshot,
  SNAPSHOT_FORMAT,
  verifySnapshotTrustedHeads,
} from "./storage-compaction.mjs";
export {
  AuthExpiredError,
  NotSupportedError,
  PreconditionFailedError,
  RateLimitedError,
  StorageError,
} from "./errors.mjs";
export { STORAGE_CAPABILITIES, storageCapabilitySet } from "./types.mjs";
