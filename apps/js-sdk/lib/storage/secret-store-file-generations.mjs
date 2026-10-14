import fs from "node:fs";
import path from "node:path";

import { DecryptionFailedError, decryptAead, encryptAead } from "../ic-crypto.mjs";
import { StorageError } from "./errors.mjs";
import { assertHardLinkCommitSupported } from "./secret-store-file-link.mjs";

export const LEGACY_SECRETS_FILENAME = "storage-secrets.enc";
export const GEN_SECRETS_PREFIX = "storage-secrets.";
export const GEN_SECRETS_SUFFIX = ".enc";
const FILE_VERSION = 1;
const FILE_AAD = new TextEncoder().encode("infinitecontext/storage-secret-store/v1");
const GEN_PAD = 12;
const MAX_GENERATION = 999_999_999_999;
const MAX_CAS_ATTEMPTS = 64;

/** @type {number} */
let testStallBeforeLinkMs = Number(process.env.IC_SECRET_STORE_TEST_STALL_BEFORE_LINK_MS || 0);

/** @param {number} ms */
export function setTestStallBeforeLinkMsForTests(ms) {
  testStallBeforeLinkMs = ms;
}

/** @param {number} gen */
export function formatGenerationSecretsFileName(gen) {
  if (!Number.isSafeInteger(gen) || gen <= 0 || gen > MAX_GENERATION) {
    throw new StorageError("Storage secret generation number out of range", "not_supported");
  }
  return `${GEN_SECRETS_PREFIX}${String(gen).padStart(GEN_PAD, "0")}${GEN_SECRETS_SUFFIX}`;
}

/** @param {string} name */
export function parseGenerationFromSecretsFileName(name) {
  if (!name.startsWith(GEN_SECRETS_PREFIX) || !name.endsWith(GEN_SECRETS_SUFFIX)) {
    return null;
  }
  const middle = name.slice(GEN_SECRETS_PREFIX.length, -GEN_SECRETS_SUFFIX.length);
  if (!/^\d+$/.test(middle)) {
    return null;
  }
  const gen = Number(middle);
  return Number.isSafeInteger(gen) && gen > 0 ? gen : null;
}

/** @param {string} rootDir */
export function listGenerationSecretPaths(rootDir) {
  /** @type {{ gen: number, path: string }[]} */
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const gen = parseGenerationFromSecretsFileName(name);
    if (gen === null) {
      continue;
    }
    const fullPath = path.join(rootDir, name);
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) {
        continue;
      }
    } catch {
      continue;
    }
    found.push({ gen, path: fullPath });
  }
  found.sort((a, b) => b.gen - a.gen);
  return found;
}

/** @param {string} rootDir */
export function highestGenerationNumber(rootDir) {
  const paths = listGenerationSecretPaths(rootDir);
  return paths.length > 0 ? paths[0].gen : 0;
}

/** @param {string} rootDir */
export function hasPersistedSecretsStore(rootDir) {
  if (fs.existsSync(path.join(rootDir, LEGACY_SECRETS_FILENAME))) {
    return true;
  }
  return listGenerationSecretPaths(rootDir).length > 0;
}

/**
 * @param {string} filePath
 * @param {Uint8Array} kek
 */
function readSecretsMapFromFile(filePath, kek) {
  rejectSymlinkPath(filePath);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "EACCES") {
        throw new StorageError(
          `Permission denied reading storage secret file at ${filePath}`,
          "permission_denied",
        );
      }
      if (error.code === "ENOENT") {
        throw new StorageError(
          `Storage secret generation file missing at ${filePath}`,
          "store_not_found",
        );
      }
    }
    throw corruptGenerationError(filePath, "Could not read storage secret file", error);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw corruptGenerationError(filePath, "Corrupt storage secret file (invalid JSON)");
  }
  if (Number(envelope?.v) !== FILE_VERSION || !envelope?.enc) {
    throw corruptGenerationError(filePath, "Unsupported storage secret file version");
  }
  let plaintext;
  try {
    plaintext = decryptAead(kek, envelope.enc, FILE_AAD);
  } catch (error) {
    if (error instanceof DecryptionFailedError) {
      throw corruptGenerationError(filePath, "Could not decrypt storage secret file");
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw corruptGenerationError(filePath, "Corrupt storage secret payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw corruptGenerationError(filePath, "Corrupt storage secret payload");
  }
  return /** @type {Record<string, string>} */ (parsed);
}

/**
 * @param {string} filePath
 * @param {string} detail
 * @param {unknown} [cause]
 */
function corruptGenerationError(filePath, detail, cause) {
  const message = `${detail} at ${filePath}`;
  if (cause instanceof Error && cause.message && !message.includes(cause.message)) {
    return new StorageError(`${message} (${cause.message})`, "corrupt_secret_store");
  }
  return new StorageError(message, "corrupt_secret_store");
}

/**
 * @param {string} rootDir
 * @param {Uint8Array} kek
 * @returns {{ gen: number, map: Record<string, string> }}
 */
export function loadLatestSecretsMap(rootDir, kek, assertHeld = () => {}) {
  migrateLegacySecretsFileIfNeeded(rootDir, kek, assertHeld);
  return loadLatestSecretsMapInner(rootDir, kek, false);
}

/**
 * @param {string} rootDir
 * @param {Uint8Array} kek
 * @param {boolean} retriedAfterMissingGen
 * @returns {{ gen: number, map: Record<string, string> }}
 */
function loadLatestSecretsMapInner(rootDir, kek, retriedAfterMissingGen) {
  const paths = listGenerationSecretPaths(rootDir);
  if (paths.length === 0) {
    return { gen: 0, map: {} };
  }
  const highest = paths[0];
  try {
    const map = readSecretsMapFromFile(highest.path, kek);
    return { gen: highest.gen, map: { ...map } };
  } catch (error) {
    if (
      !retriedAfterMissingGen &&
      error instanceof StorageError &&
      error.code === "store_not_found"
    ) {
      return loadLatestSecretsMapInner(rootDir, kek, true);
    }
    if (error instanceof StorageError && error.code === "corrupt_secret_store") {
      throw error;
    }
    if (error instanceof StorageError && error.code === "permission_denied") {
      throw error;
    }
    throw corruptGenerationError(highest.path, "Could not load storage secret file", error);
  }
}

/**
 * @param {string} rootDir
 * @param {Uint8Array} kek
 */
function migrateLegacySecretsFileIfNeeded(rootDir, kek, assertHeld) {
  const legacyPath = path.join(rootDir, LEGACY_SECRETS_FILENAME);
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  if (listGenerationSecretPaths(rootDir).length > 0) {
    return;
  }
  assertHeld();
  const map = readSecretsMapFromFile(legacyPath, kek);
  const gen = 1;
  const nextName = formatGenerationSecretsFileName(gen);
  const tmpPath = path.join(rootDir, `.${nextName}.tmp.migrate.${process.pid}.${Date.now()}`);
  const payload = encodeSecretsPayload(map, kek);
  writeTempSecretsFile(tmpPath, payload);
  assertHeld();
  const nextPath = path.join(rootDir, nextName);
  rejectSymlinkPath(nextPath);
  try {
    fs.linkSync(tmpPath, nextPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      readSecretsMapFromFile(nextPath, kek);
      try {
        fs.unlinkSync(legacyPath);
      } catch {
        // ignore
      }
      return;
    }
    throw error;
  }
  fsyncDirectory(rootDir);
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(legacyPath);
  } catch {
    // ignore
  }
}

/**
 * @param {Record<string, string>} map
 * @param {Uint8Array} kek
 */
function encodeSecretsPayload(map, kek) {
  const envelope = encryptAead(kek, new TextEncoder().encode(JSON.stringify(map)), FILE_AAD);
  return `${JSON.stringify({ v: FILE_VERSION, enc: envelope }, null, 2)}\n`;
}

/**
 * @param {string} rootDir
 * @param {Uint8Array} kek
 * @param {(current: Record<string, string>) => Record<string, string>} mutate
 * @param {() => void} assertHeld
 */
export function commitSecretsMapCas(rootDir, kek, mutate, assertHeld) {
  assertHardLinkCommitSupported(rootDir);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    try {
      assertHeld();
    } catch (error) {
      if (error instanceof StorageError && error.code === "lock_compromised") {
        throw new StorageError(
          "Lost storage secret store lock during CAS commit; retry the operation",
          "store_retry",
        );
      }
      throw error;
    }

    const { gen, map } = loadLatestSecretsMap(rootDir, kek, assertHeld);
    const nextGen = gen + 1;
    formatGenerationSecretsFileName(nextGen);
    const nextMap = mutate({ ...map });
    const payload = encodeSecretsPayload(nextMap, kek);
    const nextName = formatGenerationSecretsFileName(nextGen);
    const tmpPath = path.join(
      rootDir,
      `.${nextName}.tmp.${process.pid}.${Date.now()}.${attempt}`,
    );
    rejectSymlinkPath(tmpPath);
    writeTempSecretsFile(tmpPath, payload);

    try {
      assertHeld();
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      if (error instanceof StorageError && error.code === "lock_compromised") {
        throw new StorageError(
          "Lost storage secret store lock during CAS commit; retry the operation",
          "store_retry",
        );
      }
      throw error;
    }

    if (testStallBeforeLinkMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testStallBeforeLinkMs);
    }

    const nextPath = path.join(rootDir, nextName);
    rejectSymlinkPath(nextPath);
    try {
      fs.linkSync(tmpPath, nextPath);
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        if (fs.existsSync(nextPath)) {
          try {
            readSecretsMapFromFile(nextPath, kek);
          } catch (readError) {
            if (readError instanceof StorageError && readError.code === "corrupt_secret_store") {
              throw readError;
            }
            throw corruptGenerationError(nextPath, "Could not read existing generation file", readError);
          }
        }
        continue;
      }
      throw error;
    }

    fsyncDirectory(rootDir);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    pruneOldGenerations(rootDir, nextGen);
    return;
  }
  throw new StorageError("CAS commit failed after concurrent updates; retry the operation", "store_retry");
}

/** @param {string} tmpPath @param {string} payload */
function writeTempSecretsFile(tmpPath, payload) {
  const buf = Buffer.from(payload);
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
}

/** @param {string} rootDir @param {number} committedGen */
function pruneOldGenerations(rootDir, committedGen) {
  const keepFrom = committedGen - 2;
  for (const entry of listGenerationSecretPaths(rootDir)) {
    if (entry.gen < keepFrom) {
      try {
        fs.unlinkSync(entry.path);
      } catch {
        // ignore
      }
    }
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
