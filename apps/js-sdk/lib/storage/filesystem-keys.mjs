import { StorageError } from "./errors.mjs";

/** Reserved path segments / names used by the filesystem adapter (not valid object keys). */
export const FS_RESERVED_BASENAMES = new Set([
  "storage-objects.lock",
  "storage-objects.lock.steal",
]);

const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const RESERVED_KEY_PREFIX = ".ic-fs-";
const RESERVED_KEY_INFIX = ".ic-fs-tmp.";

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Canonical object key grammar: lowercase segments `[a-z0-9._-]+` joined by `/`.
 * Uppercase is rejected so keys stay stable on case-insensitive filesystems (macOS/Windows).
 *
 * @param {string} key
 * @returns {string}
 */
export function assertCanonicalStorageObjectKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageError("Invalid storage object key", "invalid_argument");
  }
  if (key.startsWith("/") || key.endsWith("/")) {
    throw new StorageError("Storage object key must not have a leading or trailing slash", "invalid_argument");
  }
  if (key.includes("\\")) {
    throw new StorageError("Storage object key must use forward slashes", "invalid_argument");
  }
  if (/[A-Z]/.test(key)) {
    throw new StorageError("Storage object key must be lowercase", "invalid_argument");
  }
  if (key.startsWith(RESERVED_KEY_PREFIX) || key.includes(RESERVED_KEY_INFIX)) {
    throw new StorageError("Storage object key uses a reserved prefix", "invalid_argument");
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new StorageError("Storage object key contains an invalid segment", "invalid_argument");
    }
    if (segment.startsWith(".")) {
      throw new StorageError("Storage object key segment must not start with a dot", "invalid_argument");
    }
    if (segment.endsWith(".")) {
      throw new StorageError("Storage object key segment must not end with a dot", "invalid_argument");
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new StorageError("Storage object key segment has invalid characters", "invalid_argument");
    }
    if (WINDOWS_RESERVED.has(segment.toLowerCase())) {
      throw new StorageError("Storage object key segment is a reserved device name", "invalid_argument");
    }
    if (FS_RESERVED_BASENAMES.has(segment)) {
      throw new StorageError("Storage object key segment is reserved", "invalid_argument");
    }
  }
  return key;
}

/**
 * @param {string} prefix
 * @returns {{ core: string, requireFollowingSlash: boolean }}
 */
export function normalizeListPrefix(prefix) {
  let raw = String(prefix ?? "").replace(/^\/+/, "");
  if (!raw) {
    return { core: "", requireFollowingSlash: false };
  }
  const requireFollowingSlash = raw.endsWith("/");
  if (requireFollowingSlash) {
    raw = raw.slice(0, -1);
  } else {
    raw = raw.replace(/\/+$/, "");
  }
  if (!raw) {
    return { core: "", requireFollowingSlash: false };
  }
  const segments = raw.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new StorageError("Invalid storage list prefix", "invalid_argument");
    }
    if (segment.startsWith(".") || segment.endsWith(".")) {
      throw new StorageError("Invalid storage list prefix", "invalid_argument");
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new StorageError("Invalid storage list prefix", "invalid_argument");
    }
  }
  return { core: raw, requireFollowingSlash };
}

/**
 * @param {string} key
 * @param {{ core: string, requireFollowingSlash: boolean }} prefix
 */
export function keyMatchesListPrefix(key, prefix) {
  if (!prefix.core) {
    return true;
  }
  if (prefix.requireFollowingSlash) {
    return key.startsWith(`${prefix.core}/`);
  }
  return key === prefix.core || key.startsWith(`${prefix.core}/`);
}
