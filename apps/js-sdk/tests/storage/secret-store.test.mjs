import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SecretStore, resolveSecretStoreBackend } from "../../lib/storage/secret-store.mjs";
import { keyringBackendAvailable } from "../../lib/storage/secret-store-keyring.mjs";
import { storageSecretFilePaths } from "../../lib/storage/secret-store-file.mjs";

const SAMPLE_SECRET = new TextEncoder().encode("s3-secret-access-key-not-plain-on-disk");

describe("SecretStore encrypted file backend", () => {
  it("round-trips secrets without plaintext in the secrets file", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-file-"));
    const store = new SecretStore({ mode: "file", rootDir });
    assert.equal(await store.backendKind(), "file");

    await store.set("backend/s3/prod", SAMPLE_SECRET);
    const got = await store.get("backend/s3/prod");
    assert.deepEqual(got, SAMPLE_SECRET);

    const { secretsPath } = storageSecretFilePaths(rootDir);
    const onDisk = fs.readFileSync(secretsPath, "utf8");
    assert.ok(!onDisk.includes("s3-secret-access-key-not-plain-on-disk"));
    assert.match(onDisk, /"enc"/);

    assert.equal(await store.delete("backend/s3/prod"), true);
    assert.equal(await store.get("backend/s3/prod"), null);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes secrets and kek files with mode 0600 when supported", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-mode-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("k", new Uint8Array([9, 9, 9]));
    const { secretsPath, kekPath } = storageSecretFilePaths(rootDir);
    for (const filePath of [secretsPath, kekPath]) {
      const mode = fs.statSync(filePath).mode & 0o777;
      assert.equal(mode, 0o600, filePath);
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe("SecretStore keyring backend", () => {
  it("round-trips secrets via OS keychain when available", async () => {
    if (!(await keyringBackendAvailable())) {
      return;
    }
    const name = `test/secret/${Date.now()}`;
    const store = new SecretStore({ mode: "keyring" });
    assert.equal(await store.backendKind(), "keyring");
    await store.set(name, SAMPLE_SECRET);
    assert.deepEqual(await store.get(name), SAMPLE_SECRET);
    assert.equal(await store.delete(name), true);
    assert.equal(await store.get(name), null);
  });
});

describe("resolveSecretStoreBackend auto", () => {
  it("selects file backend when forced", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-auto-"));
    const backend = await resolveSecretStoreBackend({ mode: "file", rootDir });
    assert.equal(backend.kind, "file");
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
