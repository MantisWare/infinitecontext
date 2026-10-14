import fs from "node:fs";
import path from "node:path";

import { bytesToHex } from "@noble/hashes/utils";

import {
  assertStorageCiphertext,
  scanStorageObjectForLeaks,
  storageObjectDigest,
  verifyStorageObjectForKey,
} from "./ciphertext.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import { ensurePrivateDir } from "./secret-store-private-dir.mjs";
import { STORAGE_CAPABILITIES, assertNotAborted, storageCapabilitySet } from "./types.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

const META_SUFFIX = ".ic-storage-meta";

/** @param {string} prefix */
function normalizePrefix(prefix) {
  return String(prefix ?? "").replace(/^\/+/, "");
}

/** @param {string} key */
function normalizeKey(key) {
  const normalized = normalizePrefix(key);
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    throw new Error("Invalid storage key");
  }
  return normalized;
}

/**
 * @param {string} rootDir
 * @param {string} normalizedKey
 */
function resolveBodyPath(rootDir, normalizedKey) {
  const root = path.resolve(rootDir);
  const bodyPath = path.resolve(root, normalizedKey);
  if (bodyPath !== root && !bodyPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid storage key");
  }
  return bodyPath;
}

/**
 * @param {string} bodyPath
 * @returns {string}
 */
function metaPathForBody(bodyPath) {
  return `${bodyPath}${META_SUFFIX}`;
}

/** @param {string} key @param {Uint8Array} body @param {number} revision */
function computeEtag(key, body, revision) {
  const digest = storageObjectDigest(body);
  const keyBytes = new TextEncoder().encode(`${key}\0${revision}\0`);
  const mixed = new Uint8Array(digest.length + keyBytes.length);
  mixed.set(digest, 0);
  mixed.set(keyBytes, digest.length);
  return `"fs-${bytesToHex(storageObjectDigest(mixed))}"`;
}

/**
 * @param {string} metaPath
 * @returns {{ etag: string, revision: number, modifiedAt: string } | null}
 */
function readMetaFile(metaPath) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.etag !== "string" || typeof parsed.revision !== "number") {
    throw new Error(`Corrupt storage metadata at ${metaPath}`);
  }
  return {
    etag: parsed.etag,
    revision: parsed.revision,
    modifiedAt: typeof parsed.modifiedAt === "string" ? parsed.modifiedAt : new Date().toISOString(),
  };
}

/**
 * @param {string} metaPath
 * @param {{ etag: string, revision: number, modifiedAt: string }} meta
 */
function writeMetaFileAtomic(metaPath, meta) {
  const dir = path.dirname(metaPath);
  const tmp = path.join(dir, `.${path.basename(metaPath)}.tmp.${process.pid}.${Date.now()}`);
  const payload = `${JSON.stringify(meta)}\n`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, metaPath);
  try {
    fs.chmodSync(metaPath, 0o600);
  } catch {
    // best effort
  }
}

/**
 * @param {string} bodyPath
 * @param {Uint8Array} body
 */
function writeBodyFileAtomic(bodyPath, body) {
  const dir = path.dirname(bodyPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(bodyPath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, bodyPath);
  try {
    fs.chmodSync(bodyPath, 0o600);
  } catch {
    // best effort
  }
}

/**
 * @param {string} rootDir
 * @param {string} normalizedKey
 */
function readStoredObject(rootDir, normalizedKey) {
  const bodyPath = resolveBodyPath(rootDir, normalizedKey);
  const metaPath = metaPathForBody(bodyPath);
  const meta = readMetaFile(metaPath);
  if (!meta) {
    if (fs.existsSync(bodyPath)) {
      throw new Error(`Storage object missing metadata for ${normalizedKey}`);
    }
    return null;
  }
  let body;
  try {
    body = fs.readFileSync(bodyPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return { body: new Uint8Array(body), meta, bodyPath, metaPath };
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
  let revisionCounter = 0;

  const refreshRevisionCounter = () => {
    let maxRev = 0;
    for (const key of listAllKeys(rootDir)) {
      const stored = readStoredObject(rootDir, key);
      if (stored?.meta.revision > maxRev) {
        maxRev = stored.meta.revision;
      }
    }
    revisionCounter = maxRev;
  };

  /** @type {StorageAdapter} */
  const adapter = {
    id: options.id ?? "filesystem",
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
      ensurePrivateDir(rootDir);
      refreshRevisionCounter();
    },

    async close() {
      // stateless
    },

    async get(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const normalized = normalizeKey(key);
      const stored = readStoredObject(rootDir, normalized);
      if (!stored) return null;
      verifyStorageObjectForKey(stored.body, normalized);
      return {
        body: stored.body.slice(),
        etag: stored.meta.etag,
        size: stored.body.length,
      };
    },

    async head(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const normalized = normalizeKey(key);
      const stored = readStoredObject(rootDir, normalized);
      if (!stored) return null;
      return { etag: stored.meta.etag, size: stored.body.length };
    },

    async put(key, body, putOptions = {}) {
      assertNotAborted(putOptions.signal);
      const normalized = normalizeKey(key);
      assertStorageCiphertext(body, { objectKey: normalized });
      scanStorageObjectForLeaks(normalized, body);
      if (body.length > maxObjectBytes) {
        throw new Error(`Object exceeds maxObjectBytes (${maxObjectBytes})`);
      }

      const existing = readStoredObject(rootDir, normalized);
      const ifMatch = putOptions.ifMatch;
      const ifNoneMatch = putOptions.ifNoneMatch;

      if (ifNoneMatch === "*") {
        if (existing) throw new PreconditionFailedError("Object already exists");
      } else if (ifNoneMatch !== undefined) {
        if (existing && existing.meta.etag === ifNoneMatch) {
          throw new PreconditionFailedError("ifNoneMatch matched existing ETag");
        }
      }

      if (ifMatch !== undefined) {
        if (!existing || existing.meta.etag !== ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
      }

      revisionCounter += 1;
      const storedBody = body.slice();
      const etag = computeEtag(normalized, storedBody, revisionCounter);
      const modifiedAt = new Date().toISOString();
      const bodyPath = resolveBodyPath(rootDir, normalized);
      const metaPath = metaPathForBody(bodyPath);

      writeBodyFileAtomic(bodyPath, storedBody);
      writeMetaFileAtomic(metaPath, { etag, revision: revisionCounter, modifiedAt });

      return {
        key: normalized,
        etag,
        revision: String(revisionCounter),
        size: storedBody.length,
        modifiedAt,
      };
    },

    async list(prefix, listOptions = {}) {
      assertNotAborted(listOptions.signal);
      const normalizedPrefix = normalizePrefix(prefix);
      const limit = listOptions.limit ?? 1000;
      let keys = listAllKeys(rootDir).filter((key) => key.startsWith(normalizedPrefix)).sort();
      if (listOptions.cursor) {
        const cursor = String(listOptions.cursor);
        keys = keys.filter((key) => key > cursor);
      }
      const page = keys.slice(0, limit);
      const nextCursor = keys.length > limit ? page.at(-1) : undefined;
      return {
        objects: page.map((key) => {
          const stored = readStoredObject(rootDir, key);
          return {
            key,
            etag: stored?.meta.etag,
            revision: stored?.meta.revision ? String(stored.meta.revision) : undefined,
            size: stored?.body.length ?? 0,
            modifiedAt: stored?.meta.modifiedAt,
          };
        }),
        nextCursor,
      };
    },

    async delete(key, deleteOptions = {}) {
      assertNotAborted(deleteOptions.signal);
      const normalized = normalizeKey(key);
      const stored = readStoredObject(rootDir, normalized);
      if (!stored) {
        if (deleteOptions.ifMatch !== undefined) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        return;
      }
      if (deleteOptions.ifMatch !== undefined && stored.meta.etag !== deleteOptions.ifMatch) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      try {
        fs.unlinkSync(stored.bodyPath);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      try {
        fs.unlinkSync(stored.metaPath);
      } catch {
        // ignore
      }
    },

    async rename(fromKey, toKey, renameOptions = {}) {
      assertNotAborted(renameOptions.signal);
      const fromNormalized = normalizeKey(fromKey);
      const toNormalized = normalizeKey(toKey);
      const fromStored = readStoredObject(rootDir, fromNormalized);
      if (!fromStored) {
        throw new PreconditionFailedError("rename source missing");
      }
      const toStored = readStoredObject(rootDir, toNormalized);
      if (toStored) {
        throw new PreconditionFailedError("rename destination already exists");
      }
      if (renameOptions.ifMatch !== undefined && fromStored.meta.etag !== renameOptions.ifMatch) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      const toBodyPath = resolveBodyPath(rootDir, toNormalized);
      const toMetaPath = metaPathForBody(toBodyPath);
      fs.mkdirSync(path.dirname(toBodyPath), { recursive: true, mode: 0o700 });
      fs.renameSync(fromStored.bodyPath, toBodyPath);
      fs.renameSync(fromStored.metaPath, toMetaPath);
      return {
        key: toNormalized,
        etag: fromStored.meta.etag,
        revision: String(fromStored.meta.revision),
        size: fromStored.body.length,
        modifiedAt: fromStored.meta.modifiedAt,
      };
    },
  };

  if (options.exposeInternalsForTests) {
    adapter.exposeInternalsForTests = () => collectBackingSnapshot(rootDir);
  }

  return adapter;
}

/** @param {string} rootDir */
function listAllKeys(rootDir) {
  /** @type {string[]} */
  const keys = [];
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) {
    return keys;
  }

  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(META_SUFFIX)) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const rel = path.relative(root, full);
      keys.push(rel.split(path.sep).join("/"));
    }
  };
  walk(root);
  return keys;
}

/** @param {string} rootDir */
function collectBackingSnapshot(rootDir) {
  const keys = listAllKeys(rootDir).sort();
  /** @type {Uint8Array[]} */
  const bodies = [];
  /** @type {Record<string, unknown>[]} */
  const metadata = [];
  for (const key of keys) {
    const stored = readStoredObject(rootDir, key);
    if (!stored) continue;
    bodies.push(stored.body);
    try {
      metadata.push(JSON.parse(new TextDecoder().decode(stored.body)));
    } catch {
      metadata.push({});
    }
  }
  return { keys, bodies, metadata };
}
