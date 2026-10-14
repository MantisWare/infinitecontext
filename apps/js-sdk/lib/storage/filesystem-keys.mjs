import { StorageError } from "./errors.mjs";

/** Reserved path segments / names used by the filesystem adapter (not valid object keys). */
export const FS_RESERVED_BASENAMES = new Set([
  "storage-objects.lock",
  "storage-objects.lock.steal",
]);

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_KEY_PREFIX = ".ic-fs-";
const RESERVED_KEY_INFIX = ".ic-fs-tmp.";

/**
 * Canonical object key grammar: segments of `[A-Za-z0-9._-]+` joined by `/`.
 * Rejects empty segments, `.`, `..`, leading/trailing `/`, dot-prefixed segments,
 * and keys overlapping temp/lock reserved names.
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
    if (!SEGMENT_RE.test(segment)) {
      throw new StorageError("Storage object key segment has invalid characters", "invalid_argument");
    }
    if (FS_RESERVED_BASENAMES.has(segment)) {
      throw new StorageError("Storage object key segment is reserved", "invalid_argument");
    }
  }
  return key;
}

/** @param {string} prefix */
export function normalizeListPrefix(prefix) {
  const raw = String(prefix ?? "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!raw) {
    return "";
  }
  const segments = raw.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new StorageError("Invalid storage list prefix", "invalid_argument");
    }
    if (segment.startsWith(".")) {
      throw new StorageError("Invalid storage list prefix", "invalid_argument");
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new StorageError("Invalid storage list prefix", "invalid_argument");
    }
  }
  return raw;
}
