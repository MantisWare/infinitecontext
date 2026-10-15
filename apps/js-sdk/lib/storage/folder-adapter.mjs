import fs from "node:fs";
import path from "node:path";

import { NotSupportedError, StorageError } from "./errors.mjs";
import { createFilesystemStorageAdapter } from "./filesystem-adapter.mjs";
import { loadLatestObjectGenerationAtDir } from "./filesystem-generations.mjs";
import { keyMatchesListPrefix, normalizeListPrefix } from "./filesystem-keys.mjs";
import { canonicalizeConflictStorageKey } from "./folder-conflict-copies.mjs";
import { ensureMaterializedLocalFile } from "./folder-icloud-placeholder.mjs";
import {
  physicalKeyDirsForCanonicalKey,
  scanCanonicalKeysFromObjectsTree,
} from "./folder-on-disk-scan.mjs";
import { STORAGE_CAPABILITIES, storageCapabilitySet } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

export const FOLDER_STORAGE_ADAPTER_ID = "folder";

/** Capabilities advertised for synced-folder backends (§5 level 5). */
export const FOLDER_HONEST_CAPABILITIES = storageCapabilitySet([
  STORAGE_CAPABILITIES.get,
  STORAGE_CAPABILITIES.head,
  STORAGE_CAPABILITIES.put,
  STORAGE_CAPABILITIES.list,
  STORAGE_CAPABILITIES.delete,
  STORAGE_CAPABILITIES.conditionalCreate,
]);

/**
 * @param {import("./types.mjs").StorageGetResult[]} rows
 */
function pickConsistentGetRow(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  const etag = first.etag ?? "";
  for (let i = 1; i < rows.length; i += 1) {
    if ((rows[i].etag ?? "") !== etag) {
      throw new StorageError("Conflicting sync copies for storage object", "storage_fork");
    }
  }
  return first;
}

/**
 * @param {string} rootDir
 * @param {{ keyDir: string, canonicalKey: string }} row
 * @param {number} placeholderTimeoutMs
 */
async function materializePhysicalKeyDir(rootDir, row, placeholderTimeoutMs) {
  try {
    await ensureMaterializedLocalFile(row.keyDir, {
      timeoutMs: placeholderTimeoutMs,
      useBrctl: process.platform === "darwin",
    });
  } catch (error) {
    if (error instanceof StorageError && error.code === "evicted_placeholder") {
      throw error;
    }
  }
  if (!fs.existsSync(row.keyDir)) return;
  for (const name of fs.readdirSync(row.keyDir)) {
    const full = path.join(row.keyDir, name);
    try {
      await ensureMaterializedLocalFile(full, {
        timeoutMs: placeholderTimeoutMs,
        useBrctl: process.platform === "darwin",
      });
    } catch (error) {
      if (error instanceof StorageError && error.code === "evicted_placeholder") {
        throw error;
      }
    }
  }
}

/**
 * Synced-directory storage: wraps the local filesystem adapter with honest caps and
 * conflict-copy / iCloud-placeholder handling.
 *
 * @param {{
 *   rootDir: string,
 *   id?: string,
 *   maxObjectBytes?: number,
 *   exposeInternalsForTests?: boolean,
 *   placeholderTimeoutMs?: number,
 * }} options
 */
export function createFolderStorageAdapter(options) {
  const rootDir = path.resolve(options.rootDir);
  const inner = createFilesystemStorageAdapter({
    rootDir,
    id: `${options.id ?? FOLDER_STORAGE_ADAPTER_ID}-inner`,
    maxObjectBytes: options.maxObjectBytes,
    exposeInternalsForTests: options.exposeInternalsForTests,
  });
  const placeholderTimeoutMs = options.placeholderTimeoutMs ?? 15_000;
  const objectsRoot = path.join(rootDir, "objects");

  /**
   * @param {string} key
   */
  async function listConflictGetCandidates(key) {
    const canonical = canonicalizeConflictStorageKey(key);
    const dirs = physicalKeyDirsForCanonicalKey(rootDir, canonical);
    /** @type {import("./types.mjs").StorageGetResult[]} */
    const found = [];
    for (const row of dirs) {
      await materializePhysicalKeyDir(rootDir, row, placeholderTimeoutMs);
      const latest = loadLatestObjectGenerationAtDir(rootDir, row.keyDir, row.canonicalKey);
      if (!latest || latest.header.tombstone) continue;
      found.push({
        body: latest.body,
        etag: latest.header.etag,
        size: latest.header.size,
      });
    }
    /** @type {Map<string, import("./types.mjs").StorageGetResult>} */
    const unique = new Map();
    for (const row of found) {
      const tag = row.etag ?? "";
      if (!unique.has(tag)) unique.set(tag, row);
      else if (unique.get(tag)?.etag !== row.etag) {
        throw new StorageError("Conflicting sync copies for storage object", "storage_fork");
      }
    }
    return [...unique.values()];
  }

  /**
   * @param {string} key
   */
  async function loadContributionBodiesForKey(key) {
    const rows = await listConflictGetCandidates(key);
    return rows.map((row) => row.body);
  }

  /** @type {StorageAdapter} */
  const adapter = {
    id: options.id ?? FOLDER_STORAGE_ADAPTER_ID,
    maxObjectBytes: inner.maxObjectBytes,
    serverSideTimestamps: false,
    capabilities: FOLDER_HONEST_CAPABILITIES,

    async init() {
      await inner.init();
    },

    async close() {
      await inner.close();
    },

    async get(key, options) {
      return pickConsistentGetRow(await listConflictGetCandidates(key));
    },

    async head(key, options) {
      const got = await adapter.get(key, options);
      if (!got) return null;
      return { etag: got.etag, size: got.size ?? got.body.length };
    },

    async put(key, body, options) {
      if (options?.ifMatch && !adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace)) {
        throw new NotSupportedError(
          "Folder backend does not support cross-device conditional replace (use lease locks)",
        );
      }
      return inner.put(key, body, options);
    },

    async delete(key, options) {
      if (options?.ifMatch && !adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace)) {
        throw new NotSupportedError(
          "Folder backend does not support cross-device conditional delete (use lease locks)",
        );
      }
      if (key.includes("/log/")) {
        throw new NotSupportedError("Folder backend does not delete log segments (GC disabled)");
      }
      return inner.delete(key, options);
    },

    async list(prefix, options = {}) {
      const listPrefix = normalizeListPrefix(prefix);
      const limit = options.limit ?? 1000;
      let keys = [...scanCanonicalKeysFromObjectsTree(objectsRoot, listPrefix.core)]
        .filter((key) => keyMatchesListPrefix(key, listPrefix))
        .sort();
      if (options.cursor) {
        const cursor = String(options.cursor);
        keys = keys.filter((key) => key > cursor);
      }
      const pageKeys = keys.slice(0, limit);
      const nextCursor = keys.length > limit ? pageKeys.at(-1) : undefined;
      /** @type {import("./types.mjs").StorageObjectInfo[]} */
      const objects = [];
      for (const key of pageKeys) {
        const head = await adapter.head(key);
        if (!head) continue;
        objects.push({
          key,
          etag: head.etag,
          size: head.size,
        });
      }
      return { objects, nextCursor };
    },
  };

  return Object.assign(adapter, {
    inner,
    listConflictGetCandidates,
    loadContributionBodiesForKey,
    exposeInternalsForTests: inner.exposeInternalsForTests?.bind(inner),
    removeCorruptGeneration: inner.removeCorruptGeneration?.bind(inner),
  });
}
