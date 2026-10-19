import os from "node:os";
import path from "node:path";

import { StorageError } from "./errors.mjs";

export const SFTP_OBJECT_STORE_BACKEND_ID = "sftp";

/** Writable chroot directory for `atmoz/sftp` (local emu + CI after Fix PR compose). */
export const SFTP_ATMOZ_DEFAULT_ROOT = "upload";

/** @type {readonly string[]} */
export const SFTP_CONFIG_SCALAR_KEYS = Object.freeze([
  "host",
  "port",
  "username",
  "root",
  "auth",
  "privateKeyPath",
  "knownHostsPath",
  "hostKeySha256",
  "agent",
  "timeoutMs",
  "lockTtlMs",
  "leaseSkewMs",
]);

/** @type {readonly string[]} */
export const SFTP_SECRET_STORE_KEYS = Object.freeze(["storage.sftp.password", "storage.sftp.keyPassphrase"]);

/** @type {readonly string[]} */
export const SFTP_FORBIDDEN_ARGV_SECRET_KEYS = Object.freeze([
  "storage.sftp.password",
  "storage.sftp.keyPassphrase",
]);

/**
 * @param {string} dottedKey e.g. storage.sftp.host
 */
export function assertKnownSftpConfigKey(dottedKey) {
  const key = String(dottedKey ?? "").trim();
  if (key === "storage.backend") {
    return key;
  }
  if (!key.startsWith("storage.sftp.")) {
    throw new StorageError(`Unknown storage config key "${key}"`, "invalid_argument");
  }
  const tail = key.slice("storage.sftp.".length);
  if (SFTP_SECRET_STORE_KEYS.includes(key)) {
    throw new StorageError(
      `${key} must be stored in the secret store (use \`infinitecontext config set ${key}\` with no argv value)`,
      "invalid_argument",
    );
  }
  if (!SFTP_CONFIG_SCALAR_KEYS.includes(tail)) {
    throw new StorageError(`Unknown storage.sftp config key "${tail}"`, "invalid_argument");
  }
  return key;
}

/**
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveSftpObjectStoreConfig(config = {}, env = process.env) {
  const storage = config.storage;
  const sftpBlock =
    storage && typeof storage === "object" && !Array.isArray(storage)
      ? /** @type {Record<string, unknown>} */ (storage).sftp
      : null;
  const fromBlock =
    sftpBlock && typeof sftpBlock === "object" && !Array.isArray(sftpBlock)
      ? /** @type {Record<string, unknown>} */ (sftpBlock)
      : {};

  const host = String(env.IC_SFTP_TEST_HOST ?? env.INFINITECONTEXT_SFTP_HOST ?? fromBlock.host ?? "").trim();
  const username = String(
    env.IC_SFTP_TEST_USER ?? env.INFINITECONTEXT_SFTP_USER ?? fromBlock.username ?? "",
  ).trim();
  const root = String(env.IC_SFTP_TEST_ROOT ?? env.INFINITECONTEXT_SFTP_ROOT ?? fromBlock.root ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");

  if (!host) {
    throw new StorageError(
      "storage.sftp.host (or INFINITECONTEXT_SFTP_HOST) is required when storage.backend=sftp",
      "invalid_argument",
    );
  }
  if (!username) {
    throw new StorageError("storage.sftp.username is required when storage.backend=sftp", "invalid_argument");
  }
  if (!root) {
    throw new StorageError("storage.sftp.root is required when storage.backend=sftp", "invalid_argument");
  }

  const portRaw = env.IC_SFTP_TEST_PORT ?? env.INFINITECONTEXT_SFTP_PORT ?? fromBlock.port ?? 22;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new StorageError("storage.sftp.port must be a valid TCP port", "invalid_argument");
  }

  const privateKeyPathRaw = String(
    env.IC_SFTP_TEST_PRIVATE_KEY_PATH ??
      env.INFINITECONTEXT_SFTP_PRIVATE_KEY_PATH ??
      fromBlock.privateKeyPath ??
      "",
  ).trim();
  const privateKeyPath = privateKeyPathRaw ? expandHome(privateKeyPathRaw) : undefined;

  const authRaw = String(fromBlock.auth ?? "").trim().toLowerCase();
  let auth = authRaw;
  if (!auth) {
    if (privateKeyPath) {
      auth = "key";
    } else if (String(fromBlock.agent ?? env.INFINITECONTEXT_SFTP_AGENT ?? "").trim() === "true") {
      auth = "agent";
    } else if (String(env.SSH_AUTH_SOCK ?? "").trim()) {
      auth = "agent";
    } else {
      auth = "key";
    }
  }
  if (auth !== "key" && auth !== "agent" && auth !== "password") {
    throw new StorageError('storage.sftp.auth must be "key", "agent", or "password"', "invalid_argument");
  }
  if (auth === "key" && !privateKeyPath) {
    throw new StorageError("storage.sftp.privateKeyPath is required when storage.sftp.auth=key", "invalid_argument");
  }

  const knownHostsPath = expandHome(
    String(fromBlock.knownHostsPath ?? env.INFINITECONTEXT_SFTP_KNOWN_HOSTS ?? "~/.ssh/known_hosts").trim(),
  );
  const hostKeySha256 = String(fromBlock.hostKeySha256 ?? env.INFINITECONTEXT_SFTP_HOST_KEY_SHA256 ?? "").trim();
  const agent =
    String(fromBlock.agent ?? env.INFINITECONTEXT_SFTP_AGENT ?? "").trim().toLowerCase() === "true" ||
    auth === "agent";

  const timeoutMs = Number(fromBlock.timeoutMs ?? env.INFINITECONTEXT_SFTP_TIMEOUT_MS ?? 20_000);
  const lockTtlMs = Number(fromBlock.lockTtlMs ?? env.INFINITECONTEXT_SFTP_LOCK_TTL_MS ?? 60_000);
  const leaseSkewMs = Number(fromBlock.leaseSkewMs ?? env.INFINITECONTEXT_SFTP_LEASE_SKEW_MS ?? 30_000);

  return {
    host,
    port,
    username,
    root,
    auth,
    privateKeyPath,
    knownHostsPath,
    hostKeySha256: hostKeySha256 || undefined,
    agent,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000,
    lockTtlMs: Number.isFinite(lockTtlMs) && lockTtlMs > 0 ? lockTtlMs : 60_000,
    leaseSkewMs: Number.isFinite(leaseSkewMs) && leaseSkewMs >= 0 ? leaseSkewMs : 30_000,
  };
}

/** @param {string} filePath */
function expandHome(filePath) {
  const s = String(filePath ?? "").trim();
  if (s.startsWith("~/")) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}
