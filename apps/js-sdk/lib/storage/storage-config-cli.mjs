import readline from "node:readline/promises";

import { readConfigFile, writeConfigFile, infinitecontextHome } from "../client-config.mjs";
import { StorageError } from "./errors.mjs";
import { SecretStore } from "./secret-store.mjs";
import {
  SFTP_FORBIDDEN_ARGV_SECRET_KEYS,
  SFTP_SECRET_STORE_KEYS,
  assertKnownSftpConfigKey,
} from "./sftp-config.mjs";

/**
 * @param {string} dottedKey
 * @param {string | undefined} rawValue
 */
export async function applyStorageConfigSet(dottedKey, rawValue) {
  const key = assertKnownSftpConfigKey(String(dottedKey ?? "").trim());
  if (SFTP_SECRET_STORE_KEYS.includes(key)) {
    if (rawValue !== undefined && String(rawValue).trim() !== "") {
      throw new StorageError(
        `${key} must not be passed on the command line; run \`infinitecontext config set ${key}\` to prompt securely`,
        "invalid_argument",
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let secretText = "";
    try {
      secretText = await rl.question(`Enter secret for ${key} (input hidden): `);
    } finally {
      rl.close();
    }
    const bytes = new TextEncoder().encode(String(secretText));
    if (!bytes.length) {
      throw new StorageError(`Empty secret for ${key}`, "invalid_argument");
    }
    const store = new SecretStore({ rootDir: infinitecontextHome() });
    await store.set(key, bytes);
    console.log(`Stored ${key} in the secret store (not config.json)`);
    return;
  }

  if (key === "storage.backend") {
    const value = String(rawValue ?? "").trim();
    if (!value) {
      throw new StorageError("Missing value for storage.backend", "invalid_argument");
    }
    mergeStoragePatch({ backend: value });
    console.log(`Set storage.backend=${value} in config.json`);
    return;
  }

  const tail = key.slice("storage.sftp.".length);
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new StorageError(`Missing value for ${key}`, "invalid_argument");
  }
  mergeSftpPatch({ [tail]: coerceSftpScalar(tail, value) });
  console.log(`Set ${key} in config.json`);
}

/** @param {string} dottedKey */
export function applyStorageConfigUnset(dottedKey) {
  const key = String(dottedKey ?? "").trim();
  if (SFTP_SECRET_STORE_KEYS.includes(key)) {
    throw new StorageError(`Unset ${key} via secret store tooling, not config unset`, "invalid_argument");
  }
  if (key === "storage.backend") {
    const config = readConfigFile();
    const storage = readStorageObject(config);
    delete storage.backend;
    writeConfigFile({ storage });
    console.log("Removed storage.backend from config.json");
    return;
  }
  assertKnownSftpConfigKey(key);
  const tail = key.slice("storage.sftp.".length);
  const config = readConfigFile();
  const storage = readStorageObject(config);
  const sftp = readSftpObject(storage);
  delete sftp[tail];
  writeConfigFile({ storage: { ...storage, sftp } });
  console.log(`Removed ${key} from config.json`);
}

/** @param {string} keyName @param {string | undefined} rawValue */
export function assertStorageConfigSetAllowed(keyName, rawValue) {
  const key = String(keyName ?? "").trim();
  if (!key.startsWith("storage.")) {
    return false;
  }
  if (SFTP_FORBIDDEN_ARGV_SECRET_KEYS.includes(key) && rawValue !== undefined && String(rawValue).trim() !== "") {
    throw new StorageError(
      `${key} must not be passed on the command line; run \`infinitecontext config set ${key}\` to prompt securely`,
      "invalid_argument",
    );
  }
  assertKnownSftpConfigKey(key);
  return true;
}

/** @param {Record<string, unknown>} patch */
function mergeStoragePatch(patch) {
  const config = readConfigFile();
  const storage = readStorageObject(config);
  writeConfigFile({ storage: { ...storage, ...patch } });
}

/** @param {Record<string, unknown>} patch */
function mergeSftpPatch(patch) {
  const config = readConfigFile();
  const storage = readStorageObject(config);
  const sftp = readSftpObject(storage);
  writeConfigFile({ storage: { ...storage, sftp: { ...sftp, ...patch } } });
}

/** @param {Record<string, unknown>} config */
function readStorageObject(config) {
  const storage = config.storage;
  if (storage && typeof storage === "object" && !Array.isArray(storage)) {
    return { .../** @type {Record<string, unknown>} */ (storage) };
  }
  return {};
}

/** @param {Record<string, unknown>} storage */
function readSftpObject(storage) {
  const sftp = storage.sftp;
  if (sftp && typeof sftp === "object" && !Array.isArray(sftp)) {
    return { .../** @type {Record<string, unknown>} */ (sftp) };
  }
  return {};
}

/** @param {string} tail @param {string} value */
function coerceSftpScalar(tail, value) {
  if (tail === "port" || tail === "timeoutMs" || tail === "lockTtlMs" || tail === "leaseSkewMs") {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new StorageError(`${tail} must be a number`, "invalid_argument");
    }
    return n;
  }
  if (tail === "agent") {
    return value === "true" || value === "1";
  }
  return value;
}
