import fs from "node:fs";
import path from "node:path";

import { randomBytes } from "../ic-crypto.mjs";
import { StorageError } from "./errors.mjs";
import { acquireHeartbeatLock } from "./secret-store-heartbeat-lock.mjs";
import { ensurePrivateDir } from "./secret-store-private-dir.mjs";
import {
  commitSecretsMapCas,
  hasPersistedSecretsStore,
  LEGACY_SECRETS_FILENAME,
  loadLatestSecretsMap,
} from "./secret-store-file-generations.mjs";

const KEK_FILENAME = "storage-secrets.kek";
const LOCK_FILENAME = "storage-secrets.lock";

/**
 * @param {{ rootDir: string }} options
 * @returns {import('./secret-store.mjs').SecretStoreBackend}
 */
export function createEncryptedFileSecretBackend({ rootDir }) {
  const kekPath = path.join(rootDir, KEK_FILENAME);

  return {
    kind: "file",
    async setSecret(name, secret) {
      await withSecretsFileLock(rootDir, async (assertHeld) => {
        const kek = loadOrCreateKek(kekPath, rootDir, assertHeld);
        commitSecretsMapCas(
          rootDir,
          kek,
          (map) => {
            map[name] = Buffer.from(secret).toString("base64");
            return map;
          },
          assertHeld,
        );
      });
    },
    async getSecret(name) {
      return withSecretsFileLock(rootDir, async (assertHeld) => {
        const kek = loadOrCreateKek(kekPath, rootDir, assertHeld);
        const { map } = loadLatestSecretsMap(rootDir, kek, assertHeld);
        const b64 = map[name];
        if (!b64) {
          return null;
        }
        return new Uint8Array(Buffer.from(b64, "base64"));
      });
    },
    async deleteSecret(name) {
      return withSecretsFileLock(rootDir, async (assertHeld) => {
        const kek = loadOrCreateKek(kekPath, rootDir, assertHeld);
        const { map } = loadLatestSecretsMap(rootDir, kek, assertHeld);
        if (!(name in map)) {
          return false;
        }
        commitSecretsMapCas(
          rootDir,
          kek,
          (current) => {
            delete current[name];
            return current;
          },
          assertHeld,
        );
        return true;
      });
    },
  };
}

/** @param {string} rootDir */
export function fileBackendHasPersistedStore(rootDir) {
  return hasPersistedSecretsStore(rootDir);
}

/**
 * @param {string} rootDir
 * @param {(assertHeld: () => void) => Promise<T>} fn
 * @template T
 */
async function withSecretsFileLock(rootDir, fn) {
  ensurePrivateDir(rootDir);
  const lock = await acquireHeartbeatLock(rootDir, LOCK_FILENAME);
  try {
    lock.assertHeld();
    return await fn(() => lock.assertHeld());
  } finally {
    lock.release();
  }
}

/**
 * @param {string} kekPath
 * @param {string} rootDir
 * @param {() => void} assertHeld
 */
function loadOrCreateKek(kekPath, rootDir, assertHeld) {
  ensurePrivateDir(rootDir);
  if (fs.existsSync(kekPath)) {
    rejectSymlinkPath(kekPath);
    const kek = fs.readFileSync(kekPath);
    if (kek.length !== 32) {
      throw new StorageError("Invalid storage secret KEK length", "corrupt_secret_store");
    }
    return new Uint8Array(kek);
  }
  if (hasPersistedSecretsStore(rootDir)) {
    throw new StorageError(
      "storage-secrets.enc exists but storage-secrets.kek is missing",
      "corrupt_secret_store",
    );
  }
  const kek = randomBytes(32);
  writePrivateFileAtomic(rootDir, KEK_FILENAME, Buffer.from(kek), assertHeld);
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
 * @param {(() => void) | undefined} assertHeld
 */
export function writePrivateFileAtomic(dir, fileName, contents, assertHeld) {
  ensurePrivateDir(dir);
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
    try {
      fs.writeSync(fd, buf, 0, buf.length);
      fs.fsyncSync(fd);
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    assertHeld?.();
    fs.renameSync(tmpPath, finalPath);
    fsyncDirectory(dir);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore
    }
    throw error;
  }
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

/** @param {string} rootDir @returns {{ secretsPath: string, kekPath: string, lockPath: string }} */
export function storageSecretFilePaths(rootDir) {
  return {
    secretsPath: path.join(rootDir, LEGACY_SECRETS_FILENAME),
    kekPath: path.join(rootDir, KEK_FILENAME),
    lockPath: path.join(rootDir, LOCK_FILENAME),
  };
}
