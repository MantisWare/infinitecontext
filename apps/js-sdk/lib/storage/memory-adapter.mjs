import { bytesToHex } from "@noble/hashes/utils";

import {
  assertStorageCiphertext,
  scanStorageObjectForLeaks,
  storageObjectDigest,
  verifyStorageObjectForKey,
} from "./ciphertext.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import { STORAGE_CAPABILITIES, assertNotAborted, storageCapabilitySet } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

/** @param {string} prefix */
function normalizePrefix(prefix) {
  return String(prefix ?? "").replace(/^\/+/, "");
}

/** @param {string} key */
function normalizeKey(key) {
  const normalized = normalizePrefix(key);
  if (normalized.includes("..")) {
    throw new Error("Invalid storage key");
  }
  return normalized;
}

/** @param {string} key @param {Uint8Array} body @param {number} revision */
function computeEtag(key, body, revision) {
  const digest = storageObjectDigest(body);
  const keyBytes = new TextEncoder().encode(`${key}\0${revision}\0`);
  const mixed = new Uint8Array(digest.length + keyBytes.length);
  mixed.set(digest, 0);
  mixed.set(keyBytes, digest.length);
  return `"mem-${bytesToHex(storageObjectDigest(mixed))}"`;
}

/**
 * @param {{ id?: string, maxObjectBytes?: number, exposeInternalsForTests?: boolean, corruptStripAadForTests?: boolean }} [options]
 * @returns {StorageAdapter & { exposeInternalsForTests?: () => { keys: string[], bodies: Uint8Array[] } }}
 */
export function createMemoryStorageAdapter(options = {}) {
  /** @type {Map<string, { body: Uint8Array, etag: string, revision: number, modifiedAt: string }>} */
  const objects = new Map();
  let revisionCounter = 0;
  const maxObjectBytes = options.maxObjectBytes ?? 8 * 1024 * 1024;

  /** @param {string} key */
  const readEntry = (key) => {
    const normalized = normalizeKey(key);
    if (!normalized) {
      throw new Error("Invalid storage key");
    }
    return { normalized, entry: objects.get(normalized) ?? null };
  };

  /** @type {StorageAdapter} */
  const adapter = {
    id: options.id ?? "memory",
    maxObjectBytes,
    serverSideTimestamps: false,
    capabilities: storageCapabilitySet([
      STORAGE_CAPABILITIES.get,
      STORAGE_CAPABILITIES.head,
      STORAGE_CAPABILITIES.put,
      STORAGE_CAPABILITIES.list,
      STORAGE_CAPABILITIES.delete,
      STORAGE_CAPABILITIES.conditionalCreate,
      STORAGE_CAPABILITIES.conditionalReplace,
      STORAGE_CAPABILITIES.atomicRename,
      STORAGE_CAPABILITIES.strongListAfterWrite,
    ]),

    async init() {
      objects.clear();
      revisionCounter = 0;
    },

    async close() {
      objects.clear();
    },

    async get(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const { normalized, entry } = readEntry(key);
      if (!entry) return null;
      verifyStorageObjectForKey(entry.body, normalized);
      return { body: entry.body.slice(), etag: entry.etag, size: entry.body.length };
    },

    async head(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const { entry } = readEntry(key);
      if (!entry) return null;
      return { etag: entry.etag, size: entry.body.length };
    },

    async put(key, body, putOptions = {}) {
      assertNotAborted(putOptions.signal);
      const { normalized, entry } = readEntry(key);
      assertStorageCiphertext(body, { objectKey: normalized });
      scanStorageObjectForLeaks(normalized, body);
      if (body.length > maxObjectBytes) {
        throw new Error(`Object exceeds maxObjectBytes (${maxObjectBytes})`);
      }
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

      revisionCounter += 1;
      let stored = body.slice();
      if (options.corruptStripAadForTests) {
        const parsed = JSON.parse(new TextDecoder().decode(stored));
        delete parsed.aad;
        stored = new TextEncoder().encode(JSON.stringify(parsed));
      }
      const etag = computeEtag(normalized, stored, revisionCounter);
      const modifiedAt = new Date().toISOString();
      const latest = objects.get(normalized) ?? null;
      if (ifMatch !== undefined) {
        if (!latest || latest.etag !== ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
      }
      if (ifNoneMatch === "*" && latest) {
        throw new PreconditionFailedError("Object already exists");
      }
      objects.set(normalized, { body: stored, etag, revision: revisionCounter, modifiedAt });
      return { key: normalized, etag, revision: String(revisionCounter), size: stored.length, modifiedAt };
    },

    async list(prefix, listOptions = {}) {
      assertNotAborted(listOptions.signal);
      const normalizedPrefix = normalizePrefix(prefix);
      const limit = listOptions.limit ?? 1000;
      let keys = [...objects.keys()]
        .filter((key) => key.startsWith(normalizedPrefix))
        .sort();
      if (listOptions.cursor) {
        const cursor = String(listOptions.cursor);
        keys = keys.filter((key) => key > cursor);
      }
      const page = keys.slice(0, limit);
      const nextCursor = keys.length > limit ? page.at(-1) : undefined;
      return {
        objects: page.map((key) => {
          const entry = objects.get(key);
          return {
            key,
            etag: entry?.etag,
            revision: entry?.revision ? String(entry.revision) : undefined,
            size: entry?.body.length ?? 0,
            modifiedAt: entry?.modifiedAt,
          };
        }),
        nextCursor,
      };
    },

    async delete(key, deleteOptions = {}) {
      assertNotAborted(deleteOptions.signal);
      const { normalized, entry } = readEntry(key);
      if (!entry) {
        if (deleteOptions.ifMatch !== undefined) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        return;
      }
      if (deleteOptions.ifMatch !== undefined && entry.etag !== deleteOptions.ifMatch) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      objects.delete(normalized);
    },

    async rename(fromKey, toKey, renameOptions = {}) {
      assertNotAborted(renameOptions.signal);
      const from = readEntry(fromKey);
      const to = readEntry(toKey);
      if (!from.entry) {
        throw new PreconditionFailedError("rename source missing");
      }
      if (to.entry) {
        throw new PreconditionFailedError("rename destination already exists");
      }
      if (renameOptions.ifMatch !== undefined && from.entry.etag !== renameOptions.ifMatch) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      objects.set(to.normalized, from.entry);
      objects.delete(from.normalized);
      return {
        key: to.normalized,
        etag: from.entry.etag,
        revision: String(from.entry.revision),
        size: from.entry.body.length,
        modifiedAt: from.entry.modifiedAt,
      };
    },
  };

  if (options.exposeInternalsForTests) {
    adapter.exposeInternalsForTests = () => ({
      keys: [...objects.keys()],
      bodies: [...objects.values()].map((row) => row.body),
      metadata: [...objects.values()].map((row) => {
        try {
          return JSON.parse(new TextDecoder().decode(row.body));
        } catch {
          return {};
        }
      }),
    });
  }

  return adapter;
}
