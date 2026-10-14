import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  platformKeychainMarkerId,
  readSecretStoreModeFromEnv,
  resolveSecretStoreBackend,
  SecretStore,
} from "../../lib/storage/secret-store.mjs";
import { assertDbusSendAvailableOnLinux } from "../../lib/storage/secret-store-linux-dbus.mjs";
import { keyringBackendAvailable } from "../../lib/storage/secret-store-keyring.mjs";
import {
  probeKeyringSecretService,
  resetKeyringProbeCacheForTests,
} from "../../lib/storage/secret-store-keyring-probe.mjs";
import {
  formatGenerationSecretsFileName,
  listGenerationSecretPaths,
} from "../../lib/storage/secret-store-file-generations.mjs";
import { storageSecretFilePaths } from "../../lib/storage/secret-store-file.mjs";
import {
  assertHardLinkCommitSupported,
  isHardLinkCommitSupported,
  resetHardLinkProbeCacheForTests,
} from "../../lib/storage/secret-store-file-link.mjs";
import { ensurePrivateDir } from "../../lib/storage/secret-store-private-dir.mjs";
import {
  isLockStaleByMtimeForTests,
  STALE_LOCK_MTIME_MS,
} from "../../lib/storage/secret-store-heartbeat-lock.mjs";
import {
  backendMarkerPath,
  readBackendMarker,
  writeBackendMarker,
} from "../../lib/storage/secret-store-marker.mjs";

const SAMPLE_SECRET = new TextEncoder().encode("s3-secret-access-key-not-plain-on-disk");

describe("SecretStore encrypted file backend", () => {
  it("round-trips secrets without plaintext in the secrets file", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-file-"));
    const store = new SecretStore({ mode: "file", rootDir });
    assert.equal(await store.backendKind(), "file");

    await store.set("backend/s3/prod", SAMPLE_SECRET);
    const got = await store.get("backend/s3/prod");
    assert.deepEqual(got, SAMPLE_SECRET);

    const gens = listGenerationSecretPaths(rootDir);
    assert.ok(gens.length > 0);
    const onDisk = fs.readFileSync(gens[0].path, "utf8");
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
    const gens = listGenerationSecretPaths(rootDir);
    const { kekPath } = storageSecretFilePaths(rootDir);
    for (const filePath of [gens[0].path, kekPath]) {
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
    const genPath = path.join(rootDir, formatGenerationSecretsFileName(1));
    fs.symlinkSync(trapFile, genPath);
    const store = new SecretStore({ mode: "file", rootDir });
    await assert.rejects(
      () => store.set("k", new Uint8Array([1])),
      (error) => error instanceof Error && /symlink/i.test(error.message),
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("supports hard-link CAS on this filesystem", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-link-"));
    assert.equal(isHardLinkCommitSupported(rootDir), true);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("mode=file succeeds when rootDir does not exist yet", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-newdir-parent-"));
    const rootDir = path.join(parent, "nested", "store");
    assert.ok(!fs.existsSync(rootDir));
    resetHardLinkProbeCacheForTests();
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("first", new Uint8Array([8]));
    assert.deepEqual(await store.get("first"), new Uint8Array([8]));
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("auto selects file when rootDir does not exist yet and keyring unavailable", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-auto-newdir-"));
    const rootDir = path.join(parent, "fresh", "home");
    assert.ok(!fs.existsSync(rootDir));
    resetHardLinkProbeCacheForTests();
    const prev = process.env.INFINITECONTEXT_KEYRING_DURABLE;
    try {
      process.env.INFINITECONTEXT_KEYRING_DURABLE = "0";
      resetKeyringProbeCacheForTests();
      const store = new SecretStore({ mode: "auto", rootDir });
      await store.set("auto-first", new Uint8Array([3]));
      assert.equal(await store.backendKind(), "file");
    } finally {
      if (prev === undefined) {
        delete process.env.INFINITECONTEXT_KEYRING_DURABLE;
      } else {
        process.env.INFINITECONTEXT_KEYRING_DURABLE = prev;
      }
      resetKeyringProbeCacheForTests();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not cache link probe ENOENT when the directory appears later", () => {
    resetHardLinkProbeCacheForTests();
    const rootDir = path.join(os.tmpdir(), `ic-secret-store-probe-enoent-${Date.now()}`);
    assert.ok(!fs.existsSync(rootDir));
    assert.throws(
      () => isHardLinkCommitSupported(rootDir),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "store_directory_missing",
    );
    ensurePrivateDir(rootDir);
    assert.equal(isHardLinkCommitSupported(rootDir), true);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("fails get/set/delete when the newest generation file is corrupt (no fallback)", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-corrupt-newest-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("good", new Uint8Array([1, 2]));
    await store.set("also-good", new Uint8Array([3, 4]));
    const gens = listGenerationSecretPaths(rootDir);
    assert.ok(gens.length >= 2);
    const newestPath = gens[0].path;
    fs.writeFileSync(newestPath, "{ not valid secrets json }\n");
    const expectCorrupt = (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "corrupt_secret_store" &&
      error.message.includes(newestPath);
    await assert.rejects(() => store.get("good"), expectCorrupt);
    await assert.rejects(() => store.set("x", new Uint8Array([9])), expectCorrupt);
    await assert.rejects(() => store.delete("also-good"), expectCorrupt);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("maps decrypt failures to corrupt_secret_store", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-corrupt-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("a", new Uint8Array([1]));
    const gens = listGenerationSecretPaths(rootDir);
    assert.ok(gens.length > 0);
    const secretsPath = gens[0].path;
    const raw = fs.readFileSync(secretsPath, "utf8");
    fs.writeFileSync(secretsPath, raw.replace(/"ct": "[^"]+"/, '"ct": "AAAAAAAAAAAAAAAAAAAAAA=="'));
    await assert.rejects(
      () => store.get("a"),
      (error) => error instanceof Error && "code" in error && error.code === "corrupt_secret_store",
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("does not treat a fresh lock as stale by mtime", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-fresh-lock-"));
    const { lockPath } = storageSecretFilePaths(rootDir);
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, "fresh-holder-token", { mode: 0o600 });
    assert.equal(isLockStaleByMtimeForTests(lockPath), false);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("recovers from a stale heartbeat lock (old mtime)", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-stale-lock-"));
    const { lockPath } = storageSecretFilePaths(rootDir);
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, "stale-heartbeat-token", { mode: 0o600 });
    const stale = new Date(Date.now() - STALE_LOCK_MTIME_MS - 1_000);
    fs.utimesSync(lockPath, stale, stale);
    assert.equal(isLockStaleByMtimeForTests(lockPath), true);
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("after-stale-lock", new Uint8Array([7, 7]));
    assert.deepEqual(await store.get("after-stale-lock"), new Uint8Array([7, 7]));
    assert.equal(fs.existsSync(lockPath), false);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("errors when .enc exists but KEK is missing", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-missing-kek-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("a", new Uint8Array([1, 2, 3]));
    const gens = listGenerationSecretPaths(rootDir);
    const { kekPath } = storageSecretFilePaths(rootDir);
    fs.unlinkSync(kekPath);
    await assert.rejects(
      () => store.get("a"),
      (error) =>
        error instanceof Error &&
        error.message.includes("storage-secrets.kek is missing") &&
        "code" in error &&
        error.code === "corrupt_secret_store",
    );
    assert.ok(gens.length > 0 && fs.existsSync(gens[0].path));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe("SecretStore keyring backend", () => {
  it("round-trips secrets via OS keychain when available", async (t) => {
    if (!(await keyringBackendAvailable())) {
      t.skip("OS keychain module unavailable");
      return;
    }
    resetKeyringProbeCacheForTests();
    if (!(await probeKeyringSecretService())) {
      t.skip("Secret Service / keychain probe failed in this environment");
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-keyring-"));
    const name = `test/secret/${Date.now()}`;
    const expectedKind = platformKeychainMarkerId();
    assert.ok(expectedKind);
    const store = new SecretStore({ mode: "keyring", rootDir });
    assert.equal(await store.backendKind(), expectedKind);
    await store.set(name, SAMPLE_SECRET);
    assert.deepEqual(await store.get(name), SAMPLE_SECRET);
    assert.equal(await store.delete(name), true);
    assert.equal(await store.get(name), null);
    fs.rmSync(rootDir, { recursive: true, force: true });
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

  it("persists backend marker and honors it on later resolve", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-marker-"));
    const first = new SecretStore({ mode: "file", rootDir });
    await first.set("m", new Uint8Array([1]));
    assert.equal(readBackendMarker(rootDir), "file");
    const second = await resolveSecretStoreBackend({ mode: "auto", rootDir });
    assert.equal(second.kind, "file");
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("auto selects file and writes marker when Secret Service probe fails", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-auto-probe-"));
    const prev = process.env.INFINITECONTEXT_KEYRING_DURABLE;
    try {
      process.env.INFINITECONTEXT_KEYRING_DURABLE = "0";
      resetKeyringProbeCacheForTests();
      const backend = await resolveSecretStoreBackend({ mode: "auto", rootDir });
      assert.equal(backend.kind, "file");
      assert.equal(readBackendMarker(rootDir), "file");
    } finally {
      if (prev === undefined) {
        delete process.env.INFINITECONTEXT_KEYRING_DURABLE;
      } else {
        process.env.INFINITECONTEXT_KEYRING_DURABLE = prev;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails when marker is secret-service but Secret Service is unavailable", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-marker-keyring-"));
    writeBackendMarker(rootDir, "secret-service");
    const prevForce = process.env.INFINITECONTEXT_KEYRING_PROBE_FORCE;
    try {
      process.env.INFINITECONTEXT_KEYRING_PROBE_FORCE = "fail";
      resetKeyringProbeCacheForTests();
      await assert.rejects(
        () => resolveSecretStoreBackend({ mode: "auto", rootDir }),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "migration_required" &&
          /storage-secrets\.backend is "secret-service"/.test(error.message),
      );
    } finally {
      if (prevForce === undefined) {
        delete process.env.INFINITECONTEXT_KEYRING_PROBE_FORCE;
      } else {
        process.env.INFINITECONTEXT_KEYRING_PROBE_FORCE = prevForce;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects mode/keyring mismatch with persisted marker", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-marker-mismatch-"));
    writeBackendMarker(rootDir, "file");
    await assert.rejects(
      () => resolveSecretStoreBackend({ mode: "keyring", rootDir }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "migration_required" &&
        /storage-secrets\.backend is set to "file"/.test(error.message),
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes backend marker with mode 0600 when supported", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-marker-mode-"));
    await resolveSecretStoreBackend({ mode: "file", rootDir });
    const mode = fs.statSync(backendMarkerPath(rootDir)).mode & 0o777;
    assert.equal(mode, 0o600);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("on Linux auto uses file when session D-Bus is missing", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-no-dbus-"));
    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
      resetKeyringProbeCacheForTests();
      const backend = await resolveSecretStoreBackend({ mode: "auto", rootDir });
      assert.equal(backend.kind, "file");
      assert.equal(readBackendMarker(rootDir), "file");
    } finally {
      if (prevDbus === undefined) {
        delete process.env.DBUS_SESSION_BUS_ADDRESS;
      } else {
        process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
      }
      resetKeyringProbeCacheForTests();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("on Linux reports missing dbus-send CLI", () => {
    if (process.platform !== "linux") {
      return;
    }
    const prevPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin/nonexistent-empty-path";
      assert.throws(
        () => assertDbusSendAvailableOnLinux(),
        (error) =>
          error instanceof Error &&
          /dbus-send/.test(error.message) &&
          "code" in error &&
          error.code === "not_supported",
      );
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("on Linux keyring mode fails fast when session D-Bus is missing", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-no-dbus-keyring-"));
    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
      resetKeyringProbeCacheForTests();
      await assert.rejects(
        () => resolveSecretStoreBackend({ mode: "keyring", rootDir }),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "not_supported" &&
          /DBUS_SESSION_BUS_ADDRESS|kernel keyring|Secret Service/i.test(error.message),
      );
    } finally {
      if (prevDbus === undefined) {
        delete process.env.DBUS_SESSION_BUS_ADDRESS;
      } else {
        process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
      }
      resetKeyringProbeCacheForTests();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects cross-platform marker mismatch", async () => {
    if (process.platform === "linux") {
      return;
    }
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-marker-cross-"));
    writeBackendMarker(rootDir, "secret-service");
    await assert.rejects(
      () => resolveSecretStoreBackend({ mode: "auto", rootDir }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "migration_required" &&
        /storage-secrets\.backend is "secret-service"/.test(error.message),
    );
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
