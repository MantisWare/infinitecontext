import fs from "node:fs";
import path from "node:path";

import { decryptAead, encryptAead, randomBytes } from "../ic-crypto.mjs";
import { StorageError } from "./errors.mjs";

const FILE_VERSION = 1;
const SECRETS_FILENAME = "storage-secrets.enc";
const KEK_FILENAME = "storage-secrets.kek";
const FILE_AAD = new TextEncoder().encode("infinitecontext/storage-secret-store/v1");

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
      const map = await loadSecretsMap(secretsPath, kekPath, rootDir);
      map[name] = Buffer.from(secret).toString("base64");
      await saveSecretsMap(secretsPath, kekPath, rootDir, map);
    },
    async getSecret(name) {
      const map = await loadSecretsMap(secretsPath, kekPath, rootDir);
      const b64 = map[name];
      if (!b64) {
        return null;
      }
      return new Uint8Array(Buffer.from(b64, "base64"));
    },
    async deleteSecret(name) {
      const map = await loadSecretsMap(secretsPath, kekPath, rootDir);
      if (!(name in map)) {
        return false;
      }
      delete map[name];
      await saveSecretsMap(secretsPath, kekPath, rootDir, map);
      return true;
    },
  };
}

/**
 * @param {string} secretsPath
 * @param {string} kekPath
 * @param {string} rootDir
 */
async function loadSecretsMap(secretsPath, kekPath, rootDir) {
  ensurePrivateDir(rootDir);
  if (!fs.existsSync(secretsPath)) {
    return {};
  }
  const kek = loadOrCreateKek(kekPath, rootDir);
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
  const plaintext = decryptAead(kek, envelope.enc, FILE_AAD);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
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
async function saveSecretsMap(secretsPath, kekPath, rootDir, map) {
  ensurePrivateDir(rootDir);
  const kek = loadOrCreateKek(kekPath, rootDir);
  const envelope = encryptAead(kek, new TextEncoder().encode(JSON.stringify(map)), FILE_AAD);
  const payload = JSON.stringify({ v: FILE_VERSION, enc: envelope }, null, 2);
  writePrivateFile(secretsPath, payload);
}

/**
 * @param {string} kekPath
 * @param {string} rootDir
 */
function loadOrCreateKek(kekPath, rootDir) {
  ensurePrivateDir(rootDir);
  if (fs.existsSync(kekPath)) {
    const kek = fs.readFileSync(kekPath);
    if (kek.length !== 32) {
      throw new StorageError("Invalid storage secret KEK length", "corrupt_secret_store");
    }
    return new Uint8Array(kek);
  }
  const kek = randomBytes(32);
  writePrivateFile(kekPath, Buffer.from(kek));
  return kek;
}

/** @param {string} rootDir */
function ensurePrivateDir(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(rootDir, 0o700);
  } catch {
    // best effort
  }
}

/**
 * @param {string} filePath
 * @param {string | Buffer} contents
 */
function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

/** @param {string} rootDir @returns {{ secretsPath: string, kekPath: string }} */
export function storageSecretFilePaths(rootDir) {
  return {
    secretsPath: path.join(rootDir, SECRETS_FILENAME),
    kekPath: path.join(rootDir, KEK_FILENAME),
  };
}
