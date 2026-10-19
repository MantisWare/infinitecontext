import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runStorageDoctorSftp } from "../../lib/storage/storage-doctor-sftp.mjs";
import { createSftpStorageAdapter } from "../../lib/storage/sftp-adapter.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";

describe("storage doctor sftp", () => {
  it("reports capabilities from live probe with fake adapter factory", async () => {
    const result = await runStorageDoctorSftp({
      config: {
        storage: {
          sftp: {
            host: "127.0.0.1",
            port: 2222,
            username: "ic",
            root: "upload",
            hostKeySha256: "SHA256:test",
            auth: "agent",
            agent: true,
          },
        },
      },
      adapterFactory: () => {
        /** @type {Map<string, Buffer>} */
        const files = new Map();
        const fake = {
          async connect() {},
          async end() {},
          client: {
            sftp(cb) {
              cb(null, {
                extensions: { "posix-rename@openssh.com": "1", "fsync@openssh.com": "1" },
                open(_p, _f, cb) {
                  cb(null, "h1");
                },
                write(_h, _d, _o, _l, _off, cb) {
                  cb(null);
                },
                close(_h, cb) {
                  cb(null);
                },
                ext_openssh_fsync(_h, cb) {
                  cb(null);
                },
                ext_openssh_rename(from, to, cb) {
                  files.set(String(to), Buffer.from([1]));
                  files.delete(String(from));
                  cb(null);
                },
              });
            },
          },
          async mkdir() {},
          async get() {
            return Buffer.from([1]);
          },
          async stat(p) {
            return { size: 1, modifyTime: Math.floor(Date.now() / 1000) };
          },
          async delete() {},
          async list() {
            return [];
          },
        };
        return createSftpStorageAdapter({
          host: "127.0.0.1",
          port: 22,
          username: "ic",
          root: "upload",
          hostKeySha256: "SHA256:x",
          injectClient: fake,
        });
      },
    });
    assert.equal(result.backend, "sftp");
    assert.ok(result.capabilities);
    assert.equal(result.capabilities?.crossDeviceCas, false);
  });
});
