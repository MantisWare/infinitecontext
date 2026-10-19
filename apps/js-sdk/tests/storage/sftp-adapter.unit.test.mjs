import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  runStorageAdapterContractSuite,
  sampleEncryptedObjectBytesForKey,
} from "../../lib/storage/contract-suite.mjs";
import { parseStorageObject } from "../../lib/storage/ciphertext.mjs";
import { PreconditionFailedError, NotSupportedError, StorageError } from "../../lib/storage/errors.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";
import { SFTP_TEMP_PREFIX } from "../../lib/storage/sftp-adapter.mjs";
import { createSftpStorageAdapter } from "../../lib/storage/sftp-adapter.mjs";

/**
 * Minimal in-memory fake backing store for unit tests.
 */
function createFakeSftpClient() {
  /** @type {Map<string, { body: Buffer, mtime: number }>} */
  const files = new Map();
  /** @type {boolean} */
  let posixRename = true;

  /** @type {Map<string, Buffer>} */
  const openHandles = new Map();

  const client = {
    setPosixRename(enabled) {
      posixRename = enabled;
    },
    async connect() {},
    async end() {},
    client: {
      sftp(cb) {
        const sftp = {
          extensions: {
            "posix-rename@openssh.com": posixRename ? "1" : undefined,
            "fsync@openssh.com": "1",
          },
          ext_openssh_rename: posixRename
            ? (from, to, cb) => {
                const src = String(from);
                const dst = String(to);
                const row = files.get(src);
                if (!row) {
                  cb(new Error("ENOENT"));
                  return;
                }
                files.set(dst, row);
                files.delete(src);
                cb(null);
              }
            : undefined,
          open(p, flags, cb) {
            const path = String(p);
            if (flags === "wx" && files.has(path)) {
              cb(new Error("Failure"));
              return;
            }
            const handle = `h:${path}`;
            openHandles.set(handle, Buffer.alloc(0));
            cb(null, handle);
          },
          write(h, data, _o, len, off, cb) {
            const prev = openHandles.get(String(h)) ?? Buffer.alloc(0);
            const chunk = Buffer.from(data);
            const next = Buffer.concat([prev.subarray(0, off), chunk, prev.subarray(off + len)]);
            openHandles.set(String(h), next);
            cb(null);
          },
          close(h, cb) {
            const handle = String(h);
            const path = handle.slice(2);
            if (openHandles.has(handle)) {
              files.set(path, { body: openHandles.get(handle), mtime: Date.now() });
              openHandles.delete(handle);
            }
            cb(null);
          },
          ext_openssh_fsync(_h, cb) {
            cb(null);
          },
          ext_openssh_rename(from, to, cb) {
            if (!posixRename) {
              cb(new Error("unsupported"));
              return;
            }
            const src = String(from);
            const dst = String(to);
            const row = files.get(src);
            if (!row) {
              cb(new Error("ENOENT"));
              return;
            }
            files.set(dst, row);
            files.delete(src);
            cb(null);
          },
        };
        cb(null, sftp);
      },
    },
    async mkdir() {},
    async get(p) {
      const row = files.get(String(p));
      if (!row) {
        throw Object.assign(new Error("No such file"), { code: "ENOENT" });
      }
      return row.body;
    },
    async stat(p) {
      const row = files.get(String(p));
      if (!row) {
        throw Object.assign(new Error("No such file"), { code: "ENOENT" });
      }
      return { size: row.body.length, modifyTime: Math.floor(row.mtime / 1000) };
    },
    async delete(p) {
      files.delete(String(p));
    },
    async list(dir) {
      const prefix = String(dir).replace(/\/$/, "") || "/";
      /** @type {{ name: string, type: string, size: number, modifyTime: number }[]} */
      const out = [];
      /** @type {Set<string>} */
      const childDirs = new Set();
      for (const [filePath, row] of files.entries()) {
        if (filePath === prefix) continue;
        const rel =
          filePath.startsWith(`${prefix}/`) ? filePath.slice(prefix.length + 1) : null;
        if (rel === null) continue;
        const slash = rel.indexOf("/");
        if (slash >= 0) {
          childDirs.add(rel.slice(0, slash));
          continue;
        }
        out.push({
          name: rel,
          type: "-",
          size: row.body.length,
          modifyTime: Math.floor(row.mtime / 1000),
        });
      }
      for (const name of childDirs) {
        out.push({ name, type: "d", size: 0, modifyTime: 0 });
      }
      return out;
    },
    async rename(from, to) {
      const src = String(from);
      const dst = String(to);
      if (files.has(dst)) {
        throw new Error("Failure");
      }
      const row = files.get(src);
      if (!row) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(dst, row);
      files.delete(src);
    },
    _files: files,
    _write(path, body) {
      files.set(path, { body: Buffer.from(body), mtime: Date.now() });
    },
  };
  return client;
}

describe("sftp adapter unit", () => {
  it("surfaces unavailable when ssh2-sftp-client cannot load", async () => {
    const adapter = createSftpStorageAdapter({
      host: "127.0.0.1",
      port: 22,
      username: "ic",
      root: "upload",
      hostKeySha256: "SHA256:abc",
      clientFactory: async () => {
        throw new StorageError("sftp backend needs ssh2-sftp-client: npm i ssh2-sftp-client", "unavailable");
      },
    });
    await assert.rejects(() => adapter.init(), (err) => err instanceof StorageError && err.code === "unavailable");
  });

  it("create-only and overwrite via posix-rename", async () => {
    const fake = createFakeSftpClient();
    const adapter = createSftpStorageAdapter({
      host: "127.0.0.1",
      port: 2222,
      username: "ic",
      root: "upload",
      hostKeySha256: "SHA256:due7LpKlrJmBm9hgaYNpWmvVNTx0CM+D2kOn8ZrJ7lU",
      injectClient: fake,
    });
    await adapter.init();
    const key = "accounts/unit/ic-v1/obj/test.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(() => adapter.put(key, body, { ifNoneMatch: "*" }), PreconditionFailedError);
    const body2 = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body2);
    const got = await adapter.get(key);
    assert.ok(got?.body.length);
    await adapter.close();
  });

  it("rejects ifMatch (no CAS)", async () => {
    const fake = createFakeSftpClient();
    const adapter = createSftpStorageAdapter({
      host: "127.0.0.1",
      port: 22,
      username: "ic",
      root: "upload",
      hostKeySha256: "SHA256:x",
      injectClient: fake,
    });
    await adapter.init();
    const key = "accounts/unit/ic-v1/obj/cas.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(
      () => adapter.put(key, body, { ifMatch: '"x"' }),
      (err) => err instanceof NotSupportedError,
    );
    await adapter.close();
  });

  it("without posix-rename refuses unconditional overwrite", async () => {
    const fake = createFakeSftpClient();
    fake.setPosixRename(false);
    const adapter = createSftpStorageAdapter({
      host: "127.0.0.1",
      port: 22,
      username: "ic",
      root: "upload",
      hostKeySha256: "SHA256:x",
      injectClient: fake,
    });
    await adapter.init();
    const key = "accounts/unit/ic-v1/obj/norename.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(() => adapter.put(key, body), (err) => err instanceof StorageError);
    await adapter.close();
  });

runStorageAdapterContractSuite(
  async () => {
    const fake = createFakeSftpClient();
    const adapter = createSftpStorageAdapter({
      host: "127.0.0.1",
      port: 22,
      username: "ic",
      root: "upload",
      hostKeySha256: "SHA256:x",
      injectClient: fake,
    });
    return {
      adapter,
      inspectBacking: () => {
        const keys = [...fake._files.keys()].map((p) =>
          String(p).replace(/^\/?upload\/?/, "").replace(/^\//, ""),
        );
        const bodies = keys.map((k) => {
          const direct = fake._files.get(k)?.body ?? fake._files.get(`upload/${k}`)?.body;
          return new Uint8Array(direct ?? []);
        });
        return {
          keys,
          bodies,
          metadata: keys.map((k, i) => {
            const parsed = parseStorageObject(bodies[i]);
            return { aad: parsed.aad, enc: parsed.enc };
          }),
        };
      },
    };
  },
  { describe, it, afterEach },
  {
    requiredCapabilities: [
      STORAGE_CAPABILITIES.get,
      STORAGE_CAPABILITIES.head,
      STORAGE_CAPABILITIES.put,
      STORAGE_CAPABILITIES.list,
      STORAGE_CAPABILITIES.delete,
      STORAGE_CAPABILITIES.conditionalCreate,
      STORAGE_CAPABILITIES.strongListAfterWrite,
    ],
    skipConditionalReplaceTests: true,
    skipConditionalDeleteIfMatchTests: true,
  },
);

  it("temp prefix constant matches plan", () => {
    assert.equal(SFTP_TEMP_PREFIX, ".ic-tmp-");
  });
});
