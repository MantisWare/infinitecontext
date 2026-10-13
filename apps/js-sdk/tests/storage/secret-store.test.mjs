import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  readSecretStoreModeFromEnv,
  resolveSecretStoreBackend,
  SecretStore,
} from "../../lib/storage/secret-store.mjs";
import {
  isKeyringDurableForAuto,
  keyringBackendAvailable,
} from "../../lib/storage/secret-store-keyring.mjs";
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

  it("retains all secrets under concurrent set()", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-concurrent-"));
    const store = new SecretStore({ mode: "file", rootDir });
    const n = 10;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.set(`backend/parallel/${i}`, new TextEncoder().encode(`secret-value-${i}`)),
      ),
    );
    for (let i = 0; i < n; i += 1) {
      const got = await store.get(`backend/parallel/${i}`);
      assert.deepEqual(got, new TextEncoder().encode(`secret-value-${i}`));
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("rejects symlinked secrets file paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-symlink-"));
    const trapFile = path.join(rootDir, "trap.txt");
    fs.writeFileSync(trapFile, "leaked");
    const { secretsPath } = storageSecretFilePaths(rootDir);
    fs.symlinkSync(trapFile, secretsPath);
    const store = new SecretStore({ mode: "file", rootDir });
    await assert.rejects(
      () => store.set("k", new Uint8Array([1])),
      (error) => error instanceof Error && /symlink/i.test(error.message),
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("maps decrypt failures to corrupt_secret_store", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-corrupt-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("a", new Uint8Array([1]));
    const { secretsPath } = storageSecretFilePaths(rootDir);
    const raw = fs.readFileSync(secretsPath, "utf8");
    fs.writeFileSync(secretsPath, raw.replace(/"ct": "[^"]+"/, '"ct": "AAAAAAAAAAAAAAAAAAAAAA=="'));
    await assert.rejects(
      () => store.get("a"),
      (error) => error instanceof Error && "code" in error && error.code === "corrupt_secret_store",
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("errors when .enc exists but KEK is missing", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-missing-kek-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("a", new Uint8Array([1, 2, 3]));
    const { secretsPath, kekPath } = storageSecretFilePaths(rootDir);
    fs.unlinkSync(kekPath);
    await assert.rejects(
      () => store.get("a"),
      (error) =>
        error instanceof Error &&
        error.message.includes("storage-secrets.kek is missing") &&
        "code" in error &&
        error.code === "corrupt_secret_store",
    );
    assert.ok(fs.existsSync(secretsPath));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe("SecretStore keyring backend", () => {
  it("round-trips secrets via OS keychain when available", async (t) => {
    if (!(await keyringBackendAvailable())) {
      t.skip("OS keychain module unavailable");
    }
    if (!isKeyringDurableForAuto() && process.env.INFINITECONTEXT_SECRET_STORE !== "keyring") {
      t.skip("non-durable Linux kernel keyring — use INFINITECONTEXT_SECRET_STORE=keyring to test explicitly");
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

  it("keeps file backend when storage-secrets.enc already exists", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-auto-file-"));
    const seeded = new SecretStore({ mode: "file", rootDir });
    await seeded.set("persisted", new Uint8Array([4, 5, 6]));
    const auto = new SecretStore({ mode: "auto", rootDir });
    assert.equal(await auto.backendKind(), "file");
    assert.deepEqual(await auto.get("persisted"), new Uint8Array([4, 5, 6]));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("rejects invalid INFINITECONTEXT_SECRET_STORE values", () => {
    const prev = process.env.INFINITECONTEXT_SECRET_STORE;
    try {
      process.env.INFINITECONTEXT_SECRET_STORE = "definitely-not-a-mode";
      assert.throws(
        () => readSecretStoreModeFromEnv(),
        (error) =>
          error instanceof Error &&
          /Invalid INFINITECONTEXT_SECRET_STORE/.test(error.message) &&
          "code" in error &&
          error.code === "invalid_argument",
      );
    } finally {
      if (prev === undefined) {
        delete process.env.INFINITECONTEXT_SECRET_STORE;
      } else {
        process.env.INFINITECONTEXT_SECRET_STORE = prev;
      }
    }
  });
});
