import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StorageError } from "../../lib/storage/errors.mjs";
import {
  assertKnownSftpConfigKey,
  resolveSftpObjectStoreConfig,
} from "../../lib/storage/sftp-config.mjs";
import { assertStorageConfigSetAllowed } from "../../lib/storage/storage-config-cli.mjs";

describe("sftp-config", () => {
  it("requires host, username, and root", () => {
    assert.throws(
      () => resolveSftpObjectStoreConfig({ storage: { sftp: { username: "ic", root: "upload" } } }),
      (err) => err instanceof StorageError,
    );
  });

  it("applies defaults for port, timeout, lease skew", () => {
    const cfg = resolveSftpObjectStoreConfig({
      storage: {
        sftp: {
          host: "127.0.0.1",
          username: "ic",
          root: "upload",
          privateKeyPath: "/tmp/key",
        },
      },
    });
    assert.equal(cfg.port, 22);
    assert.equal(cfg.timeoutMs, 20_000);
    assert.equal(cfg.leaseSkewMs, 30_000);
    assert.equal(cfg.auth, "key");
  });

  it("rejects unknown storage.sftp keys", () => {
    assert.throws(
      () => assertKnownSftpConfigKey("storage.sftp.notARealKey"),
      (err) => err instanceof StorageError,
    );
  });

  it("rejects secret keys on argv", () => {
    assert.throws(
      () => assertStorageConfigSetAllowed("storage.sftp.password", "secret"),
      (err) => err instanceof StorageError && /must not be passed/.test(err.message),
    );
  });

  it("allows storage.backend", () => {
    assert.equal(assertKnownSftpConfigKey("storage.backend"), "storage.backend");
  });

  it("normalizes storage.sftp.root slashes (atmoz uses upload)", () => {
    const cfg = resolveSftpObjectStoreConfig({
      storage: {
        sftp: {
          host: "127.0.0.1",
          username: "ic",
          root: "/upload/",
          privateKeyPath: "/tmp/key",
        },
      },
    });
    assert.equal(cfg.root, "upload");
  });
});
