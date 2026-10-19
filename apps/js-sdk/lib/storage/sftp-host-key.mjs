import crypto from "node:crypto";
import fs from "node:fs";

import { StorageError } from "./errors.mjs";

/**
 * OpenSSH-style SHA256 fingerprint (base64, no padding).
 *
 * @param {Buffer} rawHostKey
 */
export function sha256HostKeyFingerprint(rawHostKey) {
  const digest = crypto.createHash("sha256").update(rawHostKey).digest("base64");
  const trimmed = digest.replace(/=+$/, "");
  return `SHA256:${trimmed}`;
}

/**
 * @param {string} fingerprint
 * @param {Buffer} rawHostKey
 */
export function hostKeyMatchesFingerprint(fingerprint, rawHostKey) {
  const expected = String(fingerprint ?? "").trim();
  if (!expected) return false;
  const normalized = expected.startsWith("SHA256:") ? expected : `SHA256:${expected}`;
  return normalized === sha256HostKeyFingerprint(rawHostKey);
}

/**
 * @param {string} host
 * @param {number} port
 */
function hostLookupNames(host, port) {
  const h = String(host ?? "").trim().toLowerCase();
  const names = new Set([h, `[${h}]:${port}`]);
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") {
    names.add("127.0.0.1");
    names.add("[127.0.0.1]:22");
    names.add(`[127.0.0.1]:${port}`);
  }
  return names;
}

/**
 * @param {string} line
 * @param {Set<string>} hostNames
 * @returns {string[] | null} base64 key blobs
 */
function parseKnownHostsLine(line, hostNames) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) {
    return null;
  }
  const marker = parts[0];
  if (marker.startsWith("|1|")) {
    if (parts.length < 4) {
      return null;
    }
    const keyType = parts[2];
    const keyB64 = parts[3];
    if (!keyType.startsWith("ssh-")) {
      return null;
    }
    return [keyB64];
  }
  if (!hostNames.has(marker) && !hostNames.has(parts[0])) {
    const hostsField = parts[0].split(",");
    const any = hostsField.some((entry) => hostNames.has(entry.trim().toLowerCase()));
    if (!any) {
      return null;
    }
  }
  const keyType = parts[1];
  const keyB64 = parts[2];
  if (!keyType.startsWith("ssh-")) {
    return null;
  }
  return [keyB64];
}

/**
 * @param {string} knownHostsPath
 * @param {string} host
 * @param {number} port
 * @returns {Buffer[]}
 */
export function loadKnownHostKeys(knownHostsPath, host, port) {
  let text = "";
  try {
    text = fs.readFileSync(knownHostsPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const hostNames = hostLookupNames(host, port);
  /** @type {Buffer[]} */
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const blobs = parseKnownHostsLine(line, hostNames);
    if (!blobs) continue;
    for (const b64 of blobs) {
      try {
        keys.push(Buffer.from(b64, "base64"));
      } catch {
        /* skip malformed */
      }
    }
  }
  return keys;
}

/**
 * @param {{
 *   host: string,
 *   port: number,
 *   hostKeySha256?: string,
 *   knownHostsPath?: string,
 * }} options
 * @returns {(key: Buffer) => boolean}
 */
export function createSftpHostKeyVerifier(options) {
  const pinned = String(options.hostKeySha256 ?? "").trim();
  const knownHostsPath = options.knownHostsPath;
  /** @type {Buffer[] | null} */
  let cachedKnown = null;

  return (rawKey) => {
    const keyBuf = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey);
    if (pinned) {
      return hostKeyMatchesFingerprint(pinned, keyBuf);
    }
    if (!knownHostsPath) {
      return false;
    }
    if (!cachedKnown) {
      cachedKnown = loadKnownHostKeys(knownHostsPath, options.host, options.port);
    }
    if (!cachedKnown.length) {
      return false;
    }
    return cachedKnown.some((candidate) => candidate.equals(keyBuf));
  };
}

/**
 * @param {Buffer} rawHostKey
 */
export function unknownHostKeyRefusalMessage(rawHostKey) {
  const fp = sha256HostKeyFingerprint(rawHostKey);
  return (
    `Unknown SFTP host key (${fp}). Pin it with: infinitecontext config set storage.sftp.hostKeySha256 ${fp}`
  );
}

/**
 * @param {Buffer} rawHostKey
 * @param {string} pinnedFingerprint
 */
export function hostKeyMismatchMessage(rawHostKey, pinnedFingerprint) {
  const fp = sha256HostKeyFingerprint(rawHostKey);
  return `SFTP host key mismatch: expected ${pinnedFingerprint}, got ${fp}`;
}

/**
 * Verify host key or throw StorageError with actionable message.
 *
 * @param {Buffer} rawHostKey
 * @param {ReturnType<typeof createSftpHostKeyVerifier>} verifier
 * @param {string | undefined} pinnedFingerprint
 */
export function assertSftpHostKeyTrusted(rawHostKey, verifier, pinnedFingerprint) {
  if (verifier(rawHostKey)) {
    return sha256HostKeyFingerprint(rawHostKey);
  }
  if (pinnedFingerprint) {
    throw new StorageError(
      hostKeyMismatchMessage(rawHostKey, pinnedFingerprint),
      "auth_expired",
    );
  }
  throw new StorageError(unknownHostKeyRefusalMessage(rawHostKey), "auth_expired");
}
