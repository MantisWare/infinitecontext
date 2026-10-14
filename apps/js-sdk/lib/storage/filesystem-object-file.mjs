import fs from "node:fs";
import path from "node:path";

import { bytesToHex } from "@noble/hashes/utils";

import { storageObjectDigest } from "./ciphertext.mjs";
import { StorageError } from "./errors.mjs";
import { mapFsError } from "./filesystem-paths.mjs";

export const FS_TEMP_PREFIX = ".ic-fs-tmp.";
export const FS_TEMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * @typedef {Object} StoredObjectHeader
 * @property {string} etag
 * @property {number} revision
 * @property {number} size
 * @property {string} modifiedAt
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
 * @param {Uint8Array} fileBytes
 * @returns {{ header: StoredObjectHeader, body: Uint8Array }}
 */
export function decodeObjectFile(fileBytes) {
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
  return {
    header: {
      etag: header.etag,
      revision: header.revision,
      size: header.size,
      modifiedAt: typeof header.modifiedAt === "string" ? header.modifiedAt : new Date().toISOString(),
    },
    body,
  };
}

/**
 * @param {string} objectPath
 * @returns {{ header: StoredObjectHeader, body: Uint8Array } | null}
 */
export function readObjectFileNoFollow(objectPath) {
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
    return decodeObjectFile(new Uint8Array(buf));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} objectPath
 * @param {Uint8Array} payload
 */
export function writeObjectFileExclusiveAtomic(objectPath, payload) {
  const dir = path.dirname(objectPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `${FS_TEMP_PREFIX}${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
  );
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, payload, 0, payload.length);
    fs.fsyncSync(fd);
  } catch (error) {
    throw mapFsError(error, tmp);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  try {
    fs.renameSync(tmp, objectPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw mapFsError(error, objectPath);
  }
  fsyncDirectory(dir);
}

/** @param {string} dirPath */
export function fsyncDirectory(dirPath) {
  let dirFd;
  try {
    dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(dirFd);
  } catch {
    // best effort (platforms without O_DIRECTORY)
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
    if (!entry.isFile() || !entry.name.startsWith(FS_TEMP_PREFIX)) {
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
