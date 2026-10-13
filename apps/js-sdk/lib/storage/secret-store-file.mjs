import fs from "node:fs";
import path from "node:path";

import { DecryptionFailedError, decryptAead, encryptAead, randomBytes } from "../ic-crypto.mjs";
import { StorageError } from "./errors.mjs";

const FILE_VERSION = 1;
const SECRETS_FILENAME = "storage-secrets.enc";
const KEK_FILENAME = "storage-secrets.kek";
const LOCK_FILENAME = "storage-secrets.lock";
const FILE_AAD = new TextEncoder().encode("infinitecontext/storage-secret-store/v1");
const LOCK_TIMEOUT_MS = 30_000;

/**
 * @param {{ rootDir: string }} options
 * @returns {import('./secret-store.mjs').SecretStoreBackend}
 */
export function createEncryptedFileSecretBackend({ rootDir }) {
  const secretsPath = path.join(rootDir, SECRETS_FILENAME);
  const kekPath = path.join(rootDir, KEK_FILENAME);

  return {
    kind: "file",
    async setSecret(name, secret) {
      await withSecretsFileLock(rootDir, async () => {
        const map = loadSecretsMapUnlocked(secretsPath, kekPath, rootDir);
        map[name] = Buffer.from(secret).toString("base64");
        saveSecretsMapUnlocked(secretsPath, kekPath, rootDir, map);
      });
    },
    async getSecret(name) {
      return withSecretsFileLock(rootDir, async () => {
        const map = loadSecretsMapUnlocked(secretsPath, kekPath, rootDir);
        const b64 = map[name];
        if (!b64) {
          return null;
        }
        return new Uint8Array(Buffer.from(b64, "base64"));
      });
    },
    async deleteSecret(name) {
      return withSecretsFileLock(rootDir, async () => {
        const map = loadSecretsMapUnlocked(secretsPath, kekPath, rootDir);
        if (!(name in map)) {
          return false;
        }
        delete map[name];
        saveSecretsMapUnlocked(secretsPath, kekPath, rootDir, map);
        return true;
      });
    },
  };
}

/** @param {string} rootDir */
export function fileBackendHasPersistedStore(rootDir) {
  const { secretsPath } = storageSecretFilePaths(rootDir);
  return fs.existsSync(secretsPath);
}

/**
 * @param {string} rootDir
 * @param {() => Promise<T>} fn
 * @template T
 */
async function withSecretsFileLock(rootDir, fn) {
  ensurePrivateDir(rootDir);
  const lockPath = path.join(rootDir, LOCK_FILENAME);
  rejectSymlinkPath(lockPath);
  const lockFd = await acquireLockFile(lockPath);
  try {
    return await fn();
  } finally {
    releaseLockFile(lockPath, lockFd);
  }
}

/** @param {string} lockPath */
async function acquireLockFile(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      throw error;
    }
  }
  throw new StorageError("Timed out waiting for storage secret store lock", "lock_timeout");
}

/**
 * @param {string} lockPath
 * @param {number} lockFd
 */
function releaseLockFile(lockPath, lockFd) {
  try {
    fs.closeSync(lockFd);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/**
 * @param {string} secretsPath
 * @param {string} kekPath
 * @param {string} rootDir
 */
function loadSecretsMapUnlocked(secretsPath, kekPath, rootDir) {
  ensurePrivateDir(rootDir);
  if (!fs.existsSync(secretsPath)) {
    return {};
  }
  rejectSymlinkPath(secretsPath);
  const secretsExist = true;
  const kek = loadOrCreateKek(kekPath, rootDir, { secretsFileExists: secretsExist });
  const raw = fs.readFileSync(secretsPath, "utf8");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new StorageError("Corrupt storage secret file", "corrupt_secret_store");
  }
  if (Number(envelope?.v) !== FILE_VERSION || !envelope?.enc) {
    throw new StorageError("Unsupported storage secret file version", "corrupt_secret_store");
  }
  let plaintext;
  try {
    plaintext = decryptAead(kek, envelope.enc, FILE_AAD);
  } catch (error) {
    if (error instanceof DecryptionFailedError) {
      throw new StorageError("Could not decrypt storage secret file", "corrupt_secret_store");
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new StorageError("Corrupt storage secret payload", "corrupt_secret_store");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorageError("Corrupt storage secret payload", "corrupt_secret_store");
  }
  return /** @type {Record<string, string>} */ (parsed);
}

/**
 * @param {string} secretsPath
 * @param {string} kekPath
 * @param {string} rootDir
 * @param {Record<string, string>} map
 */
function saveSecretsMapUnlocked(secretsPath, kekPath, rootDir, map) {
  ensurePrivateDir(rootDir);
  const secretsExist = fs.existsSync(secretsPath);
  const kek = loadOrCreateKek(kekPath, rootDir, { secretsFileExists: secretsExist });
  const envelope = encryptAead(kek, new TextEncoder().encode(JSON.stringify(map)), FILE_AAD);
  const payload = `${JSON.stringify({ v: FILE_VERSION, enc: envelope }, null, 2)}\n`;
  writePrivateFileAtomic(rootDir, SECRETS_FILENAME, payload);
}

/**
 * @param {string} kekPath
 * @param {string} rootDir
 * @param {{ secretsFileExists: boolean }} context
 */
function loadOrCreateKek(kekPath, rootDir, { secretsFileExists }) {
  ensurePrivateDir(rootDir);
  if (fs.existsSync(kekPath)) {
    rejectSymlinkPath(kekPath);
    const kek = fs.readFileSync(kekPath);
    if (kek.length !== 32) {
      throw new StorageError("Invalid storage secret KEK length", "corrupt_secret_store");
    }
    return new Uint8Array(kek);
  }
  if (secretsFileExists) {
    throw new StorageError(
      "storage-secrets.enc exists but storage-secrets.kek is missing",
      "corrupt_secret_store",
    );
  }
  const kek = randomBytes(32);
  writePrivateFileAtomic(rootDir, KEK_FILENAME, Buffer.from(kek));
  return kek;
}

/** @param {string} targetPath */
function rejectSymlinkPath(targetPath) {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new StorageError("Refusing to use symlink for storage secret store path", "invalid_argument");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/**
 * @param {string} dir
 * @param {string} fileName
 * @param {string | Buffer} contents
 */
function writePrivateFileAtomic(dir, fileName, contents) {
  const finalPath = path.join(dir, fileName);
  rejectSymlinkPath(finalPath);
  const tmpPath = path.join(dir, `.${fileName}.tmp.${process.pid}.${Date.now()}`);
  rejectSymlinkPath(tmpPath);
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  let fd;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new StorageError("Refusing to follow symlink for storage secret store path", "invalid_argument");
    }
    throw error;
  }
  try {
    fs.writeSync(fd, buf, 0, buf.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
  fsyncDirectory(dir);
}

/** @param {string} dir */
function fsyncDirectory(dir) {
  if (process.platform === "win32") {
    return;
  }
  let dfd;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    fs.fsyncSync(dfd);
  } catch {
    // best effort — some platforms lack O_DIRECTORY
    try {
      dfd = fs.openSync(dir, "r");
      fs.fsyncSync(dfd);
    } catch {
      // ignore
    }
  } finally {
    if (dfd !== undefined) {
      try {
        fs.closeSync(dfd);
      } catch {
        // ignore
      }
    }
  }
}

/** @param {string} rootDir */
function ensurePrivateDir(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(rootDir, 0o700);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

/** @param {string} rootDir @returns {{ secretsPath: string, kekPath: string, lockPath: string }} */
export function storageSecretFilePaths(rootDir) {
  return {
    secretsPath: path.join(rootDir, SECRETS_FILENAME),
    kekPath: path.join(rootDir, KEK_FILENAME),
    lockPath: path.join(rootDir, LOCK_FILENAME),
  };
}
