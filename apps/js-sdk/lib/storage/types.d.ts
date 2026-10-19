export type StorageCapability =
  | "get"
  | "head"
  | "put"
  | "list"
  | "delete"
  | "conditionalCreate"
  | "conditionalReplace"
  | "strongListAfterWrite"
  | "serverSideTimestamps";

export type StorageObjectInfo = {
  key: string;
  etag?: string;
  revision?: string;
  size: number;
  modifiedAt?: string;
};

export type StorageGetResult = {
  body: Uint8Array;
  etag?: string;
  size?: number;
};

export type StorageHeadResult = {
  etag?: string;
  size: number;
};

export type StorageRequestOptions = {
  signal?: AbortSignal;
};

export type StoragePutOptions = StorageRequestOptions & {
  ifMatch?: string;
  ifNoneMatch?: string;
};

export type StorageDeleteOptions = StorageRequestOptions & {
  ifMatch?: string;
};

export type StorageListOptions = StorageRequestOptions & {
  limit?: number;
  /** Exclusive startAfter key from a prior page. */
  cursor?: string;
};

export type StorageCorruptEntry = {
  key: string;
  gen?: number;
  message: string;
};

export type StorageListResult = {
  objects: StorageObjectInfo[];
  corrupt?: StorageCorruptEntry[];
  nextCursor?: string;
};

export interface StorageAdapter {
  id: string;
  capabilities: ReadonlySet<StorageCapability>;
  maxObjectBytes?: number;
  serverSideTimestamps?: boolean;
  init(): Promise<void>;
  close(): Promise<void>;
  get(key: string, options?: StorageRequestOptions): Promise<StorageGetResult | null>;
  head(key: string, options?: StorageRequestOptions): Promise<StorageHeadResult | null>;
  put(key: string, body: Uint8Array, options?: StoragePutOptions): Promise<StorageObjectInfo>;
  list(prefix: string, options?: StorageListOptions): Promise<StorageListResult>;
  delete(key: string, options?: StorageDeleteOptions): Promise<void>;
}

export declare const STORAGE_CAPABILITIES: Readonly<Record<string, StorageCapability>>;
export declare function storageCapabilitySet(values: Iterable<StorageCapability>): Set<StorageCapability>;

export declare class StorageError extends Error {
  code: string;
}
export declare class PreconditionFailedError extends StorageError {}
export declare class NotSupportedError extends StorageError {}
export declare class AuthExpiredError extends StorageError {}
export declare class RateLimitedError extends StorageError {}

export type StorageSftpConfig = {
  host?: string;
  port?: number;
  username?: string;
  root?: string;
  auth?: "key" | "agent" | "password";
  privateKeyPath?: string;
  knownHostsPath?: string;
  hostKeySha256?: string;
  agent?: boolean;
  timeoutMs?: number;
  lockTtlMs?: number;
  leaseSkewMs?: number;
};

export declare function assertStorageCiphertext(body: unknown): void;
export declare function buildStorageObjectBytes(
  aad: string,
  envelope: Record<string, unknown>,
): Uint8Array;
export declare function isValidStorageAad(aad: string): boolean;
