import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertStorageCiphertext, scanStorageObjectForLeaks } from "./ciphertext.mjs";
import {
  assertCanonicalStorageObjectKey,
  keyMatchesListPrefix,
  normalizeListPrefix,
} from "./filesystem-keys.mjs";
import { LEASE_LOCK_TTL_MS } from "./lease-lock.mjs";
import { NotSupportedError, PreconditionFailedError, StorageError } from "./errors.mjs";
import { assertStoragePutPreconditionsSupported } from "./storage-put-preconditions.mjs";
import { SFTP_OBJECT_STORE_BACKEND_ID } from "./sftp-config.mjs";
import {
  assertSftpHostKeyTrusted,
  createSftpHostKeyVerifier,
  sha256HostKeyFingerprint,
} from "./sftp-host-key.mjs";
import { STORAGE_CAPABILITIES, assertNotAborted, storageCapabilitySet } from "./types.mjs";

export const SFTP_TEMP_PREFIX = ".ic-tmp-";
export const SFTP_TEMP_SUFFIX = ".part";

/**
 * @typedef {Object} SftpProbeCapabilities
 * @property {boolean} createExclusive
 * @property {boolean} conditionalOverwrite
 * @property {boolean} atomicRename
 * @property {boolean} createOnlyRename
 * @property {'strong'} listConsistency
 * @property {boolean} crossDeviceCas
 * @property {'lease'} locking
 * @property {boolean} posixRenameExtension
 * @property {boolean} fsyncExtension
 */

/**
 * @param {unknown} error
 */
function mapSftpError(error) {
  if (error instanceof StorageError || error instanceof PreconditionFailedError) {
    return error;
  }
  const code =
    error && typeof error === "object" && "code" in error ? String(/** @type {{ code?: string }} */ (error).code) : "";
  if (code === "ENOENT") {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists|failure/i.test(message)) {
    return new PreconditionFailedError(message);
  }
  return new StorageError(message, "storage_error");
}

/**
 * @param {import("ssh2-sftp-client").default} client
 * @returns {Promise<import("ssh2").SFTPWrapper>}
 */
function openRawSftp(client) {
  return new Promise((resolve, reject) => {
    const ssh2 = /** @type {{ client?: import("ssh2").Client }} */ (client).client;
    if (!ssh2) {
      reject(new StorageError("SFTP client missing ssh2 handle", "storage_error"));
      return;
    }
    ssh2.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(sftp);
    });
  });
}

/**
 * @param {string} remoteRoot
 * @param {string} logicalKey
 */
function remoteObjectPath(remoteRoot, logicalKey) {
  const canonical = assertCanonicalStorageObjectKey(logicalKey);
  const root = String(remoteRoot ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!root || root === ".") {
    return canonical.replace(/\\/g, "/");
  }
  return path.posix.join(root, canonical.replace(/\\/g, "/")).replace(/\/+/g, "/");
}

/**
 * @param {import("ssh2-sftp-client").default} client
 * @param {string} dirPath
 */
async function mkdirpRemote(client, dirPath) {
  const normalized = dirPath.replace(/\\/g, "/");
  try {
    await client.mkdir(normalized, true);
  } catch (error) {
    const mapped = mapSftpError(error);
    if (mapped) throw mapped;
  }
}

/**
 * @param {import("ssh2-sftp-client").default} client
 * @param {string} remoteRoot
 * @param {number} maxAgeMs
 */
async function sweepStaleSftpTempFiles(client, remoteRoot, maxAgeMs) {
  const now = Date.now();
  /** @param {string} dir */
  async function walk(dir) {
    let entries = [];
    try {
      entries = await client.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name ?? "");
      const full = path.posix.join(dir, name);
      if (entry.type === "d") {
        await walk(full);
        continue;
      }
      if (!name.startsWith(SFTP_TEMP_PREFIX) || !name.endsWith(SFTP_TEMP_SUFFIX)) {
        continue;
      }
      const mtimeMs = entry.modifyTime ? Number(entry.modifyTime) * 1000 : 0;
      if (mtimeMs > 0 && now - mtimeMs < maxAgeMs) {
        continue;
      }
      try {
        await client.delete(full);
      } catch {
        /* best-effort */
      }
    }
  }
  await walk(remoteRoot.replace(/\\/g, "/"));
}

/**
 * @param {import("ssh2").SFTPWrapper} sftp
 */
function probeOpensshExtensions(sftp) {
  const exts = /** @type {Record<string, unknown>} */ (sftp).extensions ?? {};
  const posixRename =
    Boolean(exts["posix-rename@openssh.com"]) ||
    Boolean(exts["posix-rename"]) ||
    typeof /** @type {{ ext_openssh_rename?: Function }} */ (sftp).ext_openssh_rename === "function";
  const fsync =
    Boolean(exts["fsync@openssh.com"]) ||
    Boolean(exts["fsync"]) ||
    typeof /** @type {{ ext_openssh_fsync?: Function }} */ (sftp).ext_openssh_fsync === "function";
  return { posixRename, fsync };
}

/**
 * @param {import("ssh2").SFTPWrapper} sftp
 * @param {string} handle
 */
function sftpFsyncHandle(sftp, handle) {
  return new Promise((resolve, reject) => {
    /** @type {(err: Error | null | undefined, ...args: unknown[]) => void} */
    const cb = (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(undefined);
    };
    if (typeof /** @type {{ ext_openssh_fsync?: Function }} */ (sftp).ext_openssh_fsync === "function") {
      /** @type {{ ext_openssh_fsync: (h: string, cb: typeof cb) => void }} */ (sftp).ext_openssh_fsync(handle, cb);
      return;
    }
    resolve(undefined);
  });
}

/**
 * @param {import("ssh2").SFTPWrapper} sftp
 * @param {string} fromPath
 * @param {string} toPath
 */
function sftpPosixRename(sftp, fromPath, toPath) {
  return new Promise((resolve, reject) => {
    /** @type {(err: Error | null | undefined) => void} */
    const cb = (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(undefined);
    };
    if (typeof /** @type {{ ext_openssh_rename?: Function }} */ (sftp).ext_openssh_rename === "function") {
      /** @type {{ ext_openssh_rename: (a: string, b: string, cb: typeof cb) => void }} */ (sftp).ext_openssh_rename(
        fromPath,
        toPath,
        cb,
      );
      return;
    }
    reject(new StorageError("posix-rename@openssh.com extension unavailable", "not_supported"));
  });
}

/**
 * @param {import("ssh2").SFTPWrapper} sftp
 * @param {string} remotePath
 * @param {string} flags
 */
function sftpOpen(sftp, remotePath, flags) {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, flags, (err, handle) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(handle);
    });
  });
}

/**
 * @param {import("ssh2").SFTPWrapper} sftp
 * @param {string} handle
 * @param {Buffer} data
 * @param {number} offset
 */
function sftpWrite(sftp, handle, data, offset) {
  return new Promise((resolve, reject) => {
    sftp.write(handle, data, 0, data.length, offset, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(undefined);
    });
  });
}

/**
 * @param {import("ssh2").SFTPWrapper} sftp
 * @param {string} handle
 */
function sftpClose(sftp, handle) {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(undefined);
    });
  });
}

/**
 * @param {{
 *   host: string,
 *   port: number,
 *   username: string,
 *   root: string,
 *   timeoutMs?: number,
 *   hostKeySha256?: string,
 *   knownHostsPath?: string,
 *   privateKey?: Buffer | string,
 *   passphrase?: string,
 *   password?: string,
 *   agent?: boolean,
 *   agentSocket?: string,
 *   id?: string,
 *   maxObjectBytes?: number,
 *   clientFactory?: () => Promise<import("ssh2-sftp-client").default>,
 *   injectClient?: import("ssh2-sftp-client").default,
 * }} options
 */
export function createSftpStorageAdapter(options) {
  const remoteRoot = String(options.root ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const maxObjectBytes = options.maxObjectBytes ?? 64 * 1024 * 1024;
  const hostVerifier = createSftpHostKeyVerifier({
    host: options.host,
    port: options.port,
    hostKeySha256: options.hostKeySha256,
    knownHostsPath: options.knownHostsPath,
  });

  /** @type {import("ssh2-sftp-client").default | null} */
  let client = options.injectClient ?? null;
  /** @type {SftpProbeCapabilities | null} */
  let probeCaps = null;
  /** @type {import("ssh2").SFTPWrapper | null} */
  let rawSftp = null;

  /** @type {import("./types.mjs").StorageCapability[]} */
  let capabilityList = [
    STORAGE_CAPABILITIES.get,
    STORAGE_CAPABILITIES.head,
    STORAGE_CAPABILITIES.put,
    STORAGE_CAPABILITIES.list,
    STORAGE_CAPABILITIES.delete,
    STORAGE_CAPABILITIES.conditionalCreate,
    STORAGE_CAPABILITIES.strongListAfterWrite,
  ];

  /** @type {import("./types.mjs").StorageAdapter & { sftpProbe?: () => SftpProbeCapabilities | null }} */
  const adapter = {
    id: options.id ?? SFTP_OBJECT_STORE_BACKEND_ID,
    maxObjectBytes,
    serverSideTimestamps: true,
    capabilities: storageCapabilitySet(capabilityList),

    sftpProbe() {
      return probeCaps;
    },

    async init() {
      if (!client) {
        let SftpClient;
        try {
          ({ default: SftpClient } = await import("ssh2-sftp-client"));
        } catch {
          throw new StorageError(
            "sftp backend needs ssh2-sftp-client: npm i ssh2-sftp-client",
            "unavailable",
          );
        }
        if (options.clientFactory) {
          client = await options.clientFactory();
        } else {
          client = new SftpClient();
          /** @type {Record<string, unknown>} */
          const connectOpts = {
            host: options.host,
            port: options.port,
            username: options.username,
            readyTimeout: options.timeoutMs ?? 20_000,
            hostVerifier: (key) => {
              assertSftpHostKeyTrusted(key, hostVerifier, options.hostKeySha256);
              return true;
            },
          };
          if (options.password) {
            connectOpts.password = options.password;
          }
          if (options.privateKey) {
            connectOpts.privateKey = options.privateKey;
          }
          if (options.passphrase) {
            connectOpts.passphrase = options.passphrase;
          }
          if (options.agent || options.agentSocket) {
            connectOpts.agent = options.agentSocket ?? process.env.SSH_AUTH_SOCK;
          }
          await client.connect(connectOpts);
        }
      }
      rawSftp = await openRawSftp(client);
      const { posixRename, fsync } = probeOpensshExtensions(rawSftp);
      probeCaps = {
        createExclusive: true,
        conditionalOverwrite: false,
        atomicRename: posixRename,
        createOnlyRename: !posixRename,
        listConsistency: "strong",
        crossDeviceCas: false,
        locking: "lease",
        posixRenameExtension: posixRename,
        fsyncExtension: fsync,
      };
      capabilityList = [
        STORAGE_CAPABILITIES.get,
        STORAGE_CAPABILITIES.head,
        STORAGE_CAPABILITIES.put,
        STORAGE_CAPABILITIES.list,
        STORAGE_CAPABILITIES.delete,
        STORAGE_CAPABILITIES.conditionalCreate,
        STORAGE_CAPABILITIES.strongListAfterWrite,
      ];
      adapter.capabilities = storageCapabilitySet(capabilityList);
      await sweepStaleSftpTempFiles(client, remoteRoot, LEASE_LOCK_TTL_MS);
      await mkdirpRemote(client, remoteRoot);
    },

    async close() {
      if (client) {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
      }
      client = null;
      rawSftp = null;
    },

    async get(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const remotePath = remoteObjectPath(remoteRoot, key);
      try {
        const buf = await client.get(remotePath);
        const body = buf instanceof Buffer ? new Uint8Array(buf) : new Uint8Array(buf);
        const stat = await client.stat(remotePath);
        const mtimeMs = stat.modifyTime ? Number(stat.modifyTime) * 1000 : Date.now();
        return {
          body,
          etag: `${body.length}-${mtimeMs}`,
          size: body.length,
        };
      } catch (error) {
        const mapped = mapSftpError(error);
        if (mapped === null) return null;
        throw mapped;
      }
    },

    async head(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const remotePath = remoteObjectPath(remoteRoot, key);
      try {
        const stat = await client.stat(remotePath);
        const size = Number(stat.size ?? 0);
        const mtimeMs = stat.modifyTime ? Number(stat.modifyTime) * 1000 : Date.now();
        return { etag: `${size}-${mtimeMs}`, size };
      } catch (error) {
        const mapped = mapSftpError(error);
        if (mapped === null) return null;
        throw mapped;
      }
    },

    async put(key, body, putOptions = {}) {
      assertNotAborted(putOptions.signal);
      assertStoragePutPreconditionsSupported(adapter, putOptions);
      const canonical = assertCanonicalStorageObjectKey(key);
      assertStorageCiphertext(body, { objectKey: canonical });
      scanStorageObjectForLeaks(canonical, body);
      if (body.length > maxObjectBytes) {
        throw new StorageError(`Object exceeds maxObjectBytes (${maxObjectBytes})`, "invalid_argument");
      }
      if (!client || !rawSftp) {
        throw new StorageError("SFTP adapter not initialized", "invalid_argument");
      }

      const remotePath = remoteObjectPath(remoteRoot, canonical);
      const dir = path.posix.dirname(remotePath);
      await mkdirpRemote(client, dir);

      const createOnly = putOptions.ifNoneMatch === "*";
      const buf = Buffer.from(body);

      if (createOnly) {
        if (probeCaps?.posixRenameExtension) {
          const tempPath = path.posix.join(
            dir,
            `${SFTP_TEMP_PREFIX}${crypto.randomBytes(48).toString("hex")}${SFTP_TEMP_SUFFIX}`,
          );
          try {
            await writeTempAndCommit(rawSftp, client, tempPath, remotePath, buf, {
              createOnly: true,
              usePosixRename: true,
            });
          } catch (error) {
            const mapped = mapSftpError(error);
            throw mapped ?? error;
          }
        } else {
          try {
            const handle = await sftpOpen(rawSftp, remotePath, "wx");
            try {
              await sftpWrite(rawSftp, handle, buf, 0);
              if (probeCaps?.fsyncExtension) {
                await sftpFsyncHandle(rawSftp, handle);
              }
            } finally {
              await sftpClose(rawSftp, handle);
            }
          } catch (error) {
            const mapped = mapSftpError(error);
            if (mapped instanceof PreconditionFailedError) {
              throw mapped;
            }
            throw mapped ?? new PreconditionFailedError("Create-only put failed");
          }
        }
      } else if (probeCaps?.posixRenameExtension) {
        const tempPath = path.posix.join(
          dir,
          `${SFTP_TEMP_PREFIX}${crypto.randomBytes(48).toString("hex")}${SFTP_TEMP_SUFFIX}`,
        );
        await writeTempAndCommit(rawSftp, client, tempPath, remotePath, buf, {
          createOnly: false,
          usePosixRename: true,
        });
      } else {
        throw new StorageError(
          "SFTP overwrite requires posix-rename@openssh.com; hold the lease lock for shared objects",
          "not_supported",
        );
      }

      const stat = await client.stat(remotePath);
      const mtimeMs = stat.modifyTime ? Number(stat.modifyTime) * 1000 : Date.now();
      return {
        key: canonical,
        etag: `${body.length}-${mtimeMs}`,
        revision: `${body.length}-${mtimeMs}`,
        size: body.length,
        modifiedAt: new Date(mtimeMs).toISOString(),
      };
    },

    async list(listPrefix, listOptions = {}) {
      assertNotAborted(listOptions.signal);
      const normalized = normalizeListPrefix(listPrefix);
      const limit = listOptions.limit ?? 1000;
      const logicalCore = String(normalized.core ?? "").replace(/\/+$/, "");
      const searchRoot = logicalCore
        ? path.posix.join(remoteRoot.replace(/\/+$/, ""), logicalCore.replace(/\\/g, "/"))
        : remoteRoot;
      /** @type {import("./types.mjs").StorageObjectInfo[]} */
      const objects = [];
      const startAfter = listOptions.cursor ? String(listOptions.cursor) : "";

      await walkList(client, searchRoot, remoteRoot, (logicalKey, stat) => {
        if (!keyMatchesListPrefix(logicalKey, normalized)) {
          return;
        }
        if (startAfter && logicalKey <= startAfter) {
          return;
        }
        const size = Number(stat.size ?? 0);
        const mtimeMs = stat.modifyTime ? Number(stat.modifyTime) * 1000 : undefined;
        objects.push({
          key: logicalKey,
          etag: `${size}-${mtimeMs ?? 0}`,
          revision: `${size}-${mtimeMs ?? 0}`,
          size,
          modifiedAt: mtimeMs ? new Date(mtimeMs).toISOString() : undefined,
        });
      });

      objects.sort((a, b) => a.key.localeCompare(b.key));
      const page = objects.slice(0, limit);
      const nextCursor = objects.length > limit ? page.at(-1)?.key : undefined;
      return { objects: page, nextCursor };
    },

    async delete(key, deleteOptions = {}) {
      assertNotAborted(deleteOptions.signal);
      if (deleteOptions.ifMatch !== undefined) {
        throw new NotSupportedError("Storage backend does not support conditional delete (If-Match)");
      }
      const remotePath = remoteObjectPath(remoteRoot, key);
      try {
        await client.delete(remotePath);
      } catch (error) {
        const mapped = mapSftpError(error);
        if (mapped === null) {
          return;
        }
        throw mapped;
      }
    },
  };

  return adapter;
}

/**
 * @param {import("ssh2").SFTPWrapper} rawSftp
 * @param {import("ssh2-sftp-client").default} client
 * @param {string} tempPath
 * @param {string} remotePath
 * @param {Buffer} buf
 * @param {{ createOnly: boolean, usePosixRename: boolean }} opts
 */
async function writeTempAndCommit(rawSftp, client, tempPath, remotePath, buf, opts) {
  const handle = await sftpOpen(rawSftp, tempPath, "wx");
  try {
    await sftpWrite(rawSftp, handle, buf, 0);
    await sftpFsyncHandle(rawSftp, handle);
  } finally {
    await sftpClose(rawSftp, handle);
  }
  try {
    if (opts.createOnly) {
      await client.rename(tempPath, remotePath);
    } else if (opts.usePosixRename) {
      await sftpPosixRename(rawSftp, tempPath, remotePath);
    } else {
      await client.rename(tempPath, remotePath);
    }
  } catch (error) {
    try {
      await client.delete(tempPath);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * @param {import("ssh2-sftp-client").default} client
 * @param {string} dir
 * @param {string} remoteRoot
 * @param {(logicalKey: string, stat: { size?: number, modifyTime?: number }) => void} onFile
 */
async function walkList(client, dir, remoteRoot, onFile) {
  let entries = [];
  try {
    entries = await client.list(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name ?? "");
    if (name === "." || name === "..") {
      continue;
    }
    const full = path.posix.join(dir.replace(/\\/g, "/"), name);
    if (entry.type === "d") {
      await walkList(client, full, remoteRoot, onFile);
      continue;
    }
    const rel = path.posix.relative(remoteRoot.replace(/\\/g, "/"), full);
    if (!rel || rel.startsWith("..")) {
      continue;
    }
    const logicalKey = rel.replace(/\\/g, "/");
    try {
      assertCanonicalStorageObjectKey(logicalKey);
    } catch {
      continue;
    }
    onFile(logicalKey, entry);
  }
}

/**
 * Load private key bytes for SFTP auth (path mode check for doctor).
 *
 * @param {string} privateKeyPath
 */
export function readSftpPrivateKeyFile(privateKeyPath) {
  const resolved = path.resolve(privateKeyPath);
  const stat = fs.statSync(resolved);
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    return { key: fs.readFileSync(resolved), modeWarning: `Private key mode ${mode.toString(8)} is wider than 0600` };
  }
  return { key: fs.readFileSync(resolved), modeWarning: null };
}

export { sha256HostKeyFingerprint };
