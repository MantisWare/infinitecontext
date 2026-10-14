import fs from "node:fs";
import path from "node:path";

import { bytesToHex } from "@noble/hashes/utils";

import { storageObjectDigest } from "./ciphertext.mjs";
import { StorageError } from "./errors.mjs";
import { mapFsError } from "./filesystem-paths.mjs";

export const FS_TEMP_PREFIX = ".ic-fs-tmp.";
export const FS_GEN_SUFFIX = ".icgen";
export const FS_GEN_HIGH_WATER_BASENAME = ".icgen-high-water";
export const FS_TEMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;

/** @param {string} name */
export function isFilesystemTempArtifact(name) {
  return name.startsWith(FS_TEMP_PREFIX) || name.includes(`${FS_GEN_SUFFIX}.tmp.`);
}

/**
 * @typedef {Object} StoredObjectHeader
 * @property {string} etag
 * @property {number} revision
 * @property {number} size
 * @property {string} modifiedAt
 * @property {boolean} [tombstone]
 */

/**
 * @param {string} key
 * @param {Uint8Array} body
 * @param {number} revision
 */
export function computeObjectEtag(key, body, revision) {
  const digest = storageObjectDigest(body);
  const keyBytes = new TextEncoder().encode(`${key}\0${revision}\0`);
  const mixed = new Uint8Array(digest.length + keyBytes.length);
  mixed.set(digest, 0);
  mixed.set(keyBytes, digest.length);
  return `"fs-${bytesToHex(storageObjectDigest(mixed))}"`;
}

/**
 * @param {StoredObjectHeader} header
 * @param {Uint8Array} body
 */
export function encodeObjectFile(header, body) {
  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  if (headerBytes.length > 0xffff) {
    throw new StorageError("Storage object header too large", "invalid_argument");
  }
  const out = new Uint8Array(4 + headerBytes.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, headerBytes.length, false);
  out.set(headerBytes, 4);
  out.set(body, 4 + headerBytes.length);
  return out;
}

/**
 * @param {string} key
 * @param {Uint8Array} fileBytes
 * @returns {{ header: StoredObjectHeader, body: Uint8Array }}
 */
export function decodeAndVerifyObjectFile(key, fileBytes) {
  if (fileBytes.length < 4) {
    throw new StorageError("Corrupt storage object file (too short)", "corrupt_storage");
  }
  const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen > fileBytes.length - 4) {
    throw new StorageError("Corrupt storage object file (header length)", "corrupt_storage");
  }
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(fileBytes.subarray(4, 4 + headerLen)));
  } catch {
    throw new StorageError("Corrupt storage object file (header JSON)", "corrupt_storage");
  }
  if (
    !header ||
    typeof header.etag !== "string" ||
    typeof header.revision !== "number" ||
    typeof header.size !== "number"
  ) {
    throw new StorageError("Corrupt storage object file (header fields)", "corrupt_storage");
  }
  const body = fileBytes.subarray(4 + headerLen);
  if (body.length !== header.size) {
    throw new StorageError("Corrupt storage object file (size mismatch)", "corrupt_storage");
  }
  const normalized = {
    etag: header.etag,
    revision: header.revision,
    size: header.size,
    modifiedAt: typeof header.modifiedAt === "string" ? header.modifiedAt : new Date().toISOString(),
    tombstone: header.tombstone === true,
  };
  if (!normalized.tombstone) {
    const expected = computeObjectEtag(key, body, normalized.revision);
    if (expected !== normalized.etag) {
      throw new StorageError("Corrupt storage object file (etag mismatch)", "corrupt_storage");
    }
  }
  return { header: normalized, body };
}

/**
 * @param {string} objectPath
 * @param {string} key
 * @param {string} rootDir
 * @returns {{ header: StoredObjectHeader, body: Uint8Array } | null}
 */
export function readObjectFileNoFollow(objectPath, key, rootDir) {
  let fd;
  try {
    fd = fs.openSync(objectPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw mapFsError(error, objectPath);
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isSymbolicLink()) {
      throw new StorageError(`Symlinks are not allowed (${objectPath})`, "invalid_argument");
    }
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    assertRealpathUnderRoot(objectPath, rootDir);
    return decodeAndVerifyObjectFile(key, new Uint8Array(buf));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} targetPath
 * @param {string} rootDir
 */
export function assertRealpathUnderRoot(targetPath, rootDir) {
  const rootReal = fs.realpathSync(rootDir);
  const targetReal = fs.realpathSync(targetPath);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new StorageError("Storage object path escapes the store root", "invalid_argument");
  }
}

/**
 * @param {string} tempPath
 * @param {Uint8Array} payload
 * @param {string} rootDir
 */
export function writeExclusiveTempFile(tempPath, payload, rootDir) {
  fs.mkdirSync(path.dirname(tempPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, payload, 0, payload.length);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertRealpathUnderRoot(tempPath, rootDir);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    if (error instanceof StorageError) {
      throw error;
    }
    throw mapFsError(error, tempPath);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** @param {string} dirPath */
export function fsyncDirectory(dirPath) {
  let dirFd;
  try {
    dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(dirFd);
  } catch {
    // best effort
  } finally {
    if (dirFd !== undefined) {
      fs.closeSync(dirFd);
    }
  }
}

/** @param {string} rootDir */
export function sweepStaleFilesystemTempFiles(rootDir) {
  sweepTempsInDir(rootDir);
}

/** @param {string} dir */
function sweepTempsInDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      sweepTempsInDir(full);
      continue;
    }
    if (!entry.isFile() || !isFilesystemTempArtifact(entry.name)) {
      continue;
    }
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs >= FS_TEMP_SWEEP_MAX_AGE_MS) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore
    }
  }
}
