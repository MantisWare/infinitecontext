import { assertStorageCiphertext } from "./ciphertext.mjs";
import { STORAGE_CAPABILITIES, storageCapabilitySet } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

class PreconditionFailedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PreconditionFailedError";
    this.code = "precondition_failed";
  }
}

/** @param {string} key */
function normalizeKey(key) {
  const normalized = String(key ?? "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid storage key");
  }
  return normalized;
}

/** @param {Uint8Array} body */
function nextEtag(body) {
  const hex = Array.from(body.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `"mem-${hex}-${body.length}"`;
}

/**
 * @param {{ id?: string }} [options]
 * @returns {StorageAdapter}
 */
export function createMemoryStorageAdapter(options = {}) {
  /** @type {Map<string, { body: Uint8Array, etag: string }>} */
  const objects = new Map();

  /** @param {string} key */
  const readEntry = (key) => {
    const normalized = normalizeKey(key);
    return { normalized, entry: objects.get(normalized) ?? null };
  };

  /** @type {StorageAdapter} */
  const adapter = {
    id: options.id ?? "memory",
    capabilities: storageCapabilitySet([
      STORAGE_CAPABILITIES.get,
      STORAGE_CAPABILITIES.head,
      STORAGE_CAPABILITIES.put,
      STORAGE_CAPABILITIES.list,
      STORAGE_CAPABILITIES.delete,
      STORAGE_CAPABILITIES.conditionalWrite,
    ]),

    async get(key) {
      const { entry } = readEntry(key);
      if (!entry) return null;
      return { body: entry.body.slice(), etag: entry.etag };
    },

    async head(key) {
      const { entry } = readEntry(key);
      if (!entry) return null;
      return { etag: entry.etag, size: entry.body.length };
    },

    async put(key, body, putOptions = {}) {
      assertStorageCiphertext(body);
      const { normalized, entry } = readEntry(key);
      const ifMatch = putOptions.ifMatch;
      const ifNoneMatch = putOptions.ifNoneMatch;

      if (ifNoneMatch === "*") {
        if (entry) throw new PreconditionFailedError("Object already exists");
      } else if (ifNoneMatch !== undefined) {
        if (entry && entry.etag === ifNoneMatch) {
          throw new PreconditionFailedError("ifNoneMatch matched existing ETag");
        }
      }

      if (ifMatch !== undefined) {
        if (!entry || entry.etag !== ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
      }

      const stored = body.slice();
      const etag = nextEtag(stored);
      objects.set(normalized, { body: stored, etag });
      return { key: normalized, etag, revision: etag };
    },

    async list(prefix, listOptions = {}) {
      const normalizedPrefix = normalizeKey(prefix);
      const limit = listOptions.limit ?? 1000;
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(normalizedPrefix))
        .sort();
      const slice = keys.slice(0, limit);
      return {
        objects: slice.map((key) => {
          const entry = objects.get(key);
          return { key, etag: entry?.etag, revision: entry?.etag };
        }),
        nextCursor: keys.length > limit ? slice.at(-1) : undefined,
      };
    },

    async delete(key, deleteOptions = {}) {
      const { normalized, entry } = readEntry(key);
      if (!entry) return;
      if (deleteOptions.ifMatch !== undefined && entry.etag !== deleteOptions.ifMatch) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      objects.delete(normalized);
    },
  };

  return adapter;
}

export { PreconditionFailedError };
