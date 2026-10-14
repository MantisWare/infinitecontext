import fs from "node:fs";
import path from "node:path";

import {
  assertStorageCiphertext,
  scanStorageObjectForLeaks,
  verifyStorageObjectForKey,
} from "./ciphertext.mjs";
import { PreconditionFailedError, StorageError } from "./errors.mjs";
import { assertCanonicalStorageObjectKey, normalizeListPrefix } from "./filesystem-keys.mjs";
import {
  computeObjectEtag,
  encodeObjectFile,
  readObjectFileNoFollow,
  sweepStaleFilesystemTempFiles,
  writeObjectFileExclusiveAtomic,
} from "./filesystem-object-file.mjs";
import {
  mapFsError,
  rejectSymlinkInStoreRoot,
  rejectSymlinkPath,
  resolveObjectFilePath,
} from "./filesystem-paths.mjs";
import { acquireHeartbeatLock } from "./secret-store-heartbeat-lock.mjs";
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
 * Local directory storage for ciphertext objects (dev, tests, synced-folder backends).
 *
 * @param {{ rootDir: string, id?: string, maxObjectBytes?: number, exposeInternalsForTests?: boolean }} options
 * @returns {StorageAdapter & { exposeInternalsForTests?: () => import("./contract-suite.mjs").StorageBackingSnapshot }}
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
        rejectSymlinkInStoreRoot(rootDir);
        sweepStaleFilesystemTempFiles(rootDir);
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async close() {
      // stateless
    },

    async get(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      try {
        const { canonical, objectPath } = resolveObjectFilePath(rootDir, key);
        const stored = readObjectFileNoFollow(objectPath);
        if (!stored) return null;
        verifyStorageObjectForKey(stored.body, canonical);
        return {
          body: stored.body.slice(),
          etag: stored.header.etag,
          size: stored.body.length,
        };
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async head(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      try {
        const { objectPath } = resolveObjectFilePath(rootDir, key);
        const stored = readObjectFileNoFollow(objectPath);
        if (!stored) return null;
        return { etag: stored.header.etag, size: stored.body.length };
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async put(key, body, putOptions = {}) {
      assertNotAborted(putOptions.signal);
      assertCanonicalStorageObjectKey(key);
      assertStorageCiphertext(body, { objectKey: key });
      scanStorageObjectForLeaks(key, body);
      if (body.length > maxObjectBytes) {
        throw new StorageError(`Object exceeds maxObjectBytes (${maxObjectBytes})`, "invalid_argument");
      }

      return withObjectsStoreLock(rootDir, async (assertHeld) => {
        const { canonical, objectPath } = resolveObjectFilePath(rootDir, key);
        const current = readObjectFileNoFollow(objectPath);
        checkPutPreconditions(current?.header.etag ?? null, putOptions);

        assertHeld();
        const revision = (current?.header.revision ?? 0) + 1;
        const storedBody = body.slice();
        const modifiedAt = new Date().toISOString();
        const etag = computeObjectEtag(canonical, storedBody, revision);
        const payload = encodeObjectFile(
          { etag, revision, size: storedBody.length, modifiedAt },
          storedBody,
        );

        assertHeld();
        writeObjectFileExclusiveAtomic(objectPath, payload);

        return {
          key: canonical,
          etag,
          revision: String(revision),
          size: storedBody.length,
          modifiedAt,
        };
      });
    },

    async list(prefix, listOptions = {}) {
      assertNotAborted(listOptions.signal);
      try {
        const normalizedPrefix = normalizeListPrefix(prefix);
        const limit = listOptions.limit ?? 1000;
        let keys = listObjectKeys(rootDir).filter((key) => key.startsWith(normalizedPrefix)).sort();
        if (listOptions.cursor) {
          const cursor = String(listOptions.cursor);
          keys = keys.filter((key) => key > cursor);
        }
        const page = keys.slice(0, limit);
        const nextCursor = keys.length > limit ? page.at(-1) : undefined;
        /** @type {import("./types.mjs").StorageObjectInfo[]} */
        const objects = [];
        for (const key of page) {
          try {
            const { objectPath } = resolveObjectFilePath(rootDir, key);
            const stored = readObjectFileNoFollow(objectPath);
            if (!stored) {
              continue;
            }
            objects.push({
              key,
              etag: stored.header.etag,
              revision: String(stored.header.revision),
              size: stored.body.length,
              modifiedAt: stored.header.modifiedAt,
            });
          } catch {
            continue;
          }
        }
        return { objects, nextCursor };
      } catch (error) {
        throw error instanceof StorageError ? error : mapFsError(error, rootDir);
      }
    },

    async delete(key, deleteOptions = {}) {
      assertNotAborted(deleteOptions.signal);
      return withObjectsStoreLock(rootDir, async (assertHeld) => {
        const { objectPath } = resolveObjectFilePath(rootDir, key);
        const current = readObjectFileNoFollow(objectPath);
        if (!current) {
          if (deleteOptions.ifMatch !== undefined) {
            throw new PreconditionFailedError("ifMatch precondition failed");
          }
          return;
        }
        if (deleteOptions.ifMatch !== undefined && current.header.etag !== deleteOptions.ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        assertHeld();
        try {
          fs.unlinkSync(objectPath);
        } catch (error) {
          throw mapFsError(error, objectPath);
        }
      });
    },

    async rename(fromKey, toKey, renameOptions = {}) {
      assertNotAborted(renameOptions.signal);
      return withObjectsStoreLock(rootDir, async (assertHeld) => {
        const from = resolveObjectFilePath(rootDir, fromKey);
        const to = resolveObjectFilePath(rootDir, toKey);
        const current = readObjectFileNoFollow(from.objectPath);
        if (!current) {
          throw new PreconditionFailedError("rename source missing");
        }
        if (readObjectFileNoFollow(to.objectPath)) {
          throw new PreconditionFailedError("rename destination already exists");
        }
        if (renameOptions.ifMatch !== undefined && current.header.etag !== renameOptions.ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        assertHeld();
        fs.mkdirSync(path.dirname(to.objectPath), { recursive: true, mode: 0o700 });
        try {
          fs.renameSync(from.objectPath, to.objectPath);
        } catch (error) {
          throw mapFsError(error, to.objectPath);
        }
        return {
          key: to.canonical,
          etag: current.header.etag,
          revision: String(current.header.revision),
          size: current.body.length,
          modifiedAt: current.header.modifiedAt,
        };
      });
    },
  };

  if (options.exposeInternalsForTests) {
    adapter.exposeInternalsForTests = () => collectBackingSnapshot(rootDir);
  }

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
function listObjectKeys(rootDir) {
  /** @type {string[]} */
  const keys = [];
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) {
    return keys;
  }
  rejectSymlinkPath(root);

  /** @param {string} dir @param {string} relPrefix */
  const walk = (dir, relPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".ic-fs-") || entry.name === OBJECTS_LOCK_FILENAME) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relKey = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      try {
        assertCanonicalStorageObjectKey(relKey);
        keys.push(relKey);
      } catch {
        // skip non-object artifacts
      }
    }
  };
  walk(root, "");
  return keys;
}

/** @param {string} rootDir */
function collectBackingSnapshot(rootDir) {
  const keys = listObjectKeys(rootDir).sort();
  /** @type {Uint8Array[]} */
  const bodies = [];
  /** @type {Record<string, unknown>[]} */
  const metadata = [];
  for (const key of keys) {
    try {
      const { objectPath } = resolveObjectFilePath(rootDir, key);
      const stored = readObjectFileNoFollow(objectPath);
      if (!stored) continue;
      bodies.push(stored.body);
      try {
        metadata.push(JSON.parse(new TextDecoder().decode(stored.body)));
      } catch {
        metadata.push({});
      }
    } catch {
      // skip
    }
  }
  return { keys, bodies, metadata };
}
