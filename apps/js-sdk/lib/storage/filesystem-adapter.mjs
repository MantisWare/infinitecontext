import path from "node:path";

import {
  assertStorageCiphertext,
  scanStorageObjectForLeaks,
  rebindStorageObjectForKey,
  verifyStorageObjectForKey,
} from "./ciphertext.mjs";
import { PreconditionFailedError, StorageError } from "./errors.mjs";
import {
  assertCanonicalStorageObjectKey,
  keyMatchesListPrefix,
  normalizeListPrefix,
} from "./filesystem-keys.mjs";
import {
  buildLiveObjectHeader,
  buildTombstoneHeader,
  commitObjectGenerationCas,
  listAllObjectKeys,
  loadLatestObjectGeneration,
  removeObjectGenerationForRepair,
} from "./filesystem-generations.mjs";
import { sweepStaleFilesystemTempFiles } from "./filesystem-object-file.mjs";
import { mapFsError, rejectSymlinkInStoreRoot } from "./filesystem-paths.mjs";
import { acquireHeartbeatLock } from "./secret-store-heartbeat-lock.mjs";
import { assertHardLinkCommitSupported } from "./secret-store-file-link.mjs";
import { ensurePrivateDir } from "./secret-store-private-dir.mjs";
import { STORAGE_CAPABILITIES, assertNotAborted, storageCapabilitySet } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

const OBJECTS_LOCK_FILENAME = "storage-objects.lock";

/**
 * @param {string} rootDir
 * @param {(assertHeld: () => void) => Promise<T>} fn
 * @template T
 */
async function withObjectsStoreLock(rootDir, fn) {
  ensurePrivateDir(rootDir);
  rejectSymlinkInStoreRoot(rootDir);
  const handle = await acquireHeartbeatLock(rootDir, OBJECTS_LOCK_FILENAME);
  try {
    return await fn(handle.assertHeld);
  } finally {
    handle.release();
  }
}

/**
 * @param {string} rootDir
 * @param {string} key
 */
function readLiveObject(rootDir, key) {
  const latest = loadLatestObjectGeneration(rootDir, key);
  if (!latest || latest.header.tombstone) {
    return null;
  }
  verifyStorageObjectForKey(latest.body, key);
  return latest;
}

/**
 * Local directory storage for ciphertext objects (dev, tests, synced-folder backends).
 *
 * @param {{ rootDir: string, id?: string, maxObjectBytes?: number, exposeInternalsForTests?: boolean }} options
 * @returns {StorageAdapter & { exposeInternalsForTests?: () => import("./contract-suite.mjs").StorageBackingSnapshot, removeCorruptGeneration?: (key: string, gen: number) => void }}
 */
export function createFilesystemStorageAdapter(options) {
  const rootDir = path.resolve(options.rootDir);
  const maxObjectBytes = options.maxObjectBytes ?? 64 * 1024 * 1024;

  /** @type {StorageAdapter} */
  const adapter = {
    id: options.id ?? "filesystem",
    maxObjectBytes,
    serverSideTimestamps: false,
    capabilities: storageCapabilitySet([
      STORAGE_CAPABILITIES.get,
      STORAGE_CAPABILITIES.head,
      STORAGE_CAPABILITIES.list,
      STORAGE_CAPABILITIES.put,
      STORAGE_CAPABILITIES.delete,
      STORAGE_CAPABILITIES.conditionalCreate,
      STORAGE_CAPABILITIES.conditionalReplace,
      STORAGE_CAPABILITIES.atomicRename,
      STORAGE_CAPABILITIES.strongListAfterWrite,
    ]),

    async init() {
      try {
        ensurePrivateDir(rootDir);
        assertHardLinkCommitSupported(rootDir);
        rejectSymlinkInStoreRoot(rootDir);
        sweepStaleFilesystemTempFiles(rootDir);
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async close() {},

    async get(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      try {
        const canonical = assertCanonicalStorageObjectKey(key);
        const live = readLiveObject(rootDir, canonical);
        if (!live) return null;
        return {
          body: live.body.slice(),
          etag: live.header.etag,
          size: live.body.length,
        };
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async head(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      try {
        const canonical = assertCanonicalStorageObjectKey(key);
        const live = readLiveObject(rootDir, canonical);
        if (!live) return null;
        return { etag: live.header.etag, size: live.body.length };
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async put(key, body, putOptions = {}) {
      assertNotAborted(putOptions.signal);
      const canonical = assertCanonicalStorageObjectKey(key);
      assertStorageCiphertext(body, { objectKey: canonical });
      scanStorageObjectForLeaks(canonical, body);
      if (body.length > maxObjectBytes) {
        throw new StorageError(`Object exceeds maxObjectBytes (${maxObjectBytes})`, "invalid_argument");
      }
      const storedBody = body.slice();

      return withObjectsStoreLock(rootDir, async (assertHeld) => {
        const committed = commitObjectGenerationCas(rootDir, assertHeld, canonical, (state) => {
          const live = state.header && !state.header.tombstone;
          checkPutPreconditions(live ? state.header.etag : null, putOptions);
          const revision = (state.header?.revision ?? 0) + 1;
          return buildLiveObjectHeader(canonical, storedBody, revision);
        });
        return {
          key: canonical,
          etag: committed.header.etag,
          revision: String(committed.header.revision),
          size: committed.body.length,
          modifiedAt: committed.header.modifiedAt,
        };
      });
    },

    async list(prefix, listOptions = {}) {
      assertNotAborted(listOptions.signal);
      try {
        const listPrefix = normalizeListPrefix(prefix);
        const limit = listOptions.limit ?? 1000;
        let keys = listAllObjectKeys(rootDir)
          .filter((key) => keyMatchesListPrefix(key, listPrefix))
          .sort();
        if (listOptions.cursor) {
          const cursor = String(listOptions.cursor);
          keys = keys.filter((key) => key > cursor);
        }
        const page = keys.slice(0, limit);
        const nextCursor = keys.length > limit ? page.at(-1) : undefined;
        /** @type {import("./types.mjs").StorageObjectInfo[]} */
        const objects = [];
        for (const key of page) {
          let live;
          try {
            live = readLiveObject(rootDir, key);
          } catch (error) {
            if (error instanceof StorageError && error.code === "corrupt_storage") {
              throw new StorageError(
                `Corrupt storage object at key ${key} (${error.message})`,
                "corrupt_storage",
              );
            }
            throw error;
          }
          if (!live) {
            continue;
          }
          objects.push({
            key,
            etag: live.header.etag,
            revision: String(live.header.revision),
            size: live.body.length,
            modifiedAt: live.header.modifiedAt,
          });
        }
        return { objects, nextCursor };
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async delete(key, deleteOptions = {}) {
      assertNotAborted(deleteOptions.signal);
      const canonical = assertCanonicalStorageObjectKey(key);
      return withObjectsStoreLock(rootDir, async (assertHeld) => {
        const latest = loadLatestObjectGeneration(rootDir, canonical);
        const live = latest && !latest.header.tombstone;
        if (!live) {
          if (deleteOptions.ifMatch !== undefined) {
            throw new PreconditionFailedError("ifMatch precondition failed");
          }
          return;
        }
        commitObjectGenerationCas(rootDir, assertHeld, canonical, (state) => {
          const stillLive = state.header && !state.header.tombstone;
          if (!stillLive) {
            throw new PreconditionFailedError("ifMatch precondition failed");
          }
          if (deleteOptions.ifMatch !== undefined && state.header.etag !== deleteOptions.ifMatch) {
            throw new PreconditionFailedError("ifMatch precondition failed");
          }
          const revision = (state.header?.revision ?? 0) + 1;
          return buildTombstoneHeader(revision);
        });
      });
    },

    async rename(fromKey, toKey, renameOptions = {}) {
      assertNotAborted(renameOptions.signal);
      const fromCanonical = assertCanonicalStorageObjectKey(fromKey);
      const toCanonical = assertCanonicalStorageObjectKey(toKey);
      return withObjectsStoreLock(rootDir, async (assertHeld) => {
        const src = loadLatestObjectGeneration(rootDir, fromCanonical);
        if (!src || src.header.tombstone) {
          throw new PreconditionFailedError("rename source missing");
        }
        if (renameOptions.ifMatch !== undefined && src.header.etag !== renameOptions.ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        const dstLive = readLiveObject(rootDir, toCanonical);
        if (dstLive) {
          throw new PreconditionFailedError("rename destination already exists");
        }

        commitObjectGenerationCas(rootDir, assertHeld, fromCanonical, (state) => {
          const live = state.header && !state.header.tombstone;
          if (!live || state.header.etag !== src.header.etag) {
            throw new PreconditionFailedError("ifMatch precondition failed");
          }
          const revision = (state.header?.revision ?? 0) + 1;
          return buildTombstoneHeader(revision);
        });

        const rebound = rebindStorageObjectForKey(src.body.slice(), toCanonical);
        const committed = commitObjectGenerationCas(rootDir, assertHeld, toCanonical, (state) => {
          if (state.header && !state.header.tombstone) {
            throw new PreconditionFailedError("rename destination already exists");
          }
          checkPutPreconditions(state.header && !state.header.tombstone ? state.header.etag : null, {
            ifNoneMatch: "*",
          });
          const revision = (state.header?.revision ?? 0) + 1;
          return buildLiveObjectHeader(toCanonical, rebound, revision);
        });

        return {
          key: toCanonical,
          etag: committed.header.etag,
          revision: String(committed.header.revision),
          size: committed.body.length,
          modifiedAt: committed.header.modifiedAt,
        };
      });
    },
  };

  if (options.exposeInternalsForTests) {
    adapter.exposeInternalsForTests = () => collectBackingSnapshot(rootDir);
  }
  adapter.removeCorruptGeneration = (key, gen) => {
    removeObjectGenerationForRepair(rootDir, key, gen);
  };

  return adapter;
}

/**
 * @param {string | null} currentEtag
 * @param {{ ifMatch?: string, ifNoneMatch?: string }} putOptions
 */
function checkPutPreconditions(currentEtag, putOptions) {
  const ifMatch = putOptions.ifMatch;
  const ifNoneMatch = putOptions.ifNoneMatch;
  if (ifNoneMatch === "*") {
    if (currentEtag !== null) {
      throw new PreconditionFailedError("Object already exists");
    }
  } else if (ifNoneMatch !== undefined) {
    if (currentEtag !== null && currentEtag === ifNoneMatch) {
      throw new PreconditionFailedError("ifNoneMatch matched existing ETag");
    }
  }
  if (ifMatch !== undefined) {
    if (currentEtag === null || currentEtag !== ifMatch) {
      throw new PreconditionFailedError("ifMatch precondition failed");
    }
  }
}

/** @param {string} rootDir */
function collectBackingSnapshot(rootDir) {
  const keys = listAllObjectKeys(rootDir).sort();
  /** @type {Uint8Array[]} */
  const bodies = [];
  /** @type {Record<string, unknown>[]} */
  const metadata = [];
  for (const key of keys) {
    const live = readLiveObject(rootDir, key);
    if (!live) continue;
    bodies.push(live.body);
    try {
      metadata.push(JSON.parse(new TextDecoder().decode(live.body)));
    } catch {
      metadata.push({});
    }
  }
  return { keys, bodies, metadata };
}
