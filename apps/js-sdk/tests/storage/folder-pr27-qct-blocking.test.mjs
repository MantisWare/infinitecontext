import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import { objectStorePullSyncChanges, objectStorePushSyncMutations } from "../../lib/object-store-sync.mjs";
import { writeConfigFile } from "../../lib/client-config.mjs";
import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createFolderStorageAdapter } from "../../lib/storage/folder-adapter.mjs";
import { quarantineObjectsRelativePath } from "../../lib/storage/folder-quarantine.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { objectKeyDirectory } from "../../lib/storage/filesystem-generations.mjs";
import { deriveDevH, logSegmentRelativePath } from "../../lib/storage/layout.mjs";
import { storeUnlockedDek } from "../../lib/vault-keychain.mjs";
import {
  clearTestVaultContextProvider,
  setTestVaultContextProvider,
} from "../../lib/vault-session.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { resetObjectStoreBootstrapForTests } from "../../lib/sync-object-store-bootstrap.mjs";

const DEK = new Uint8Array(32).fill(33);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "accounts/local";
const TEST_ACCOUNT_KEY = "ic-test-account-key";

function syncCtx(adapter, deviceUuid, localState = createInMemoryObjectStoreLocalState()) {
  return {
    adapter,
    dek: DEK,
    layoutPrefix: PREFIX,
    selfDevH: deriveDevH(DEK, deviceUuid),
    deviceUuid,
    localState,
  };
}

function addForeignFileLevelCopy(root, key, foreignSuffix = "-foreign") {
  const { keyDir } = objectKeyDirectory(root, key);
  const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
  assert.ok(gen);
  fs.copyFileSync(
    path.join(keyDir, gen),
    path.join(keyDir, gen.replace(".icgen", " 2.icgen")),
  );
  const foreignPath = path.join(keyDir, gen.replace(".icgen", " 2.icgen"));
  fs.writeFileSync(foreignPath, sampleEncryptedObjectBytesForKey(key + foreignSuffix));
}

describe("PR27 Q/C/T blocking (46861d9)", () => {
  afterEach(async () => {
    await resetObjectStoreBootstrapForTests();
    clearTestVaultContextProvider();
  });

  describe("Q1 quarantine destination reuse", () => {
    it("removes source when quarantine dest already exists and is byte-identical (crash after copy)", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-q1-ident-"));
      const rel = "accounts/local/ic-v1/log/abc/000000000000.enc";
      const src = path.join(root, "objects", rel);
      fs.mkdirSync(src, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(src, "000000000001.icgen"), Buffer.from("payload-a"));
      const quarantineRoot = path.join(root, "quarantine", "repair");
      fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(quarantineRoot, rel), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(quarantineRoot, rel, "000000000001.icgen"), Buffer.from("payload-a"));
      assert.equal(quarantineObjectsRelativePath(root, rel, quarantineRoot), true);
      assert.equal(fs.existsSync(src), false);
    });

    it("quarantines under a unique suffix when dest exists with different content (reused iCloud name)", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-q1-diff-"));
      const rel = "accounts/local/ic-v1/log/abc/000000000000.enc";
      const src = path.join(root, "objects", rel);
      fs.mkdirSync(src, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(src, "000000000001.icgen"), Buffer.from("live-conflict"));
      const quarantineRoot = path.join(root, "quarantine", "repair");
      fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(quarantineRoot, rel), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(quarantineRoot, rel, "000000000001.icgen"), Buffer.from("stale-quarantine"));
      assert.equal(quarantineObjectsRelativePath(root, rel, quarantineRoot), true);
      assert.equal(fs.existsSync(src), false);
      const parent = path.join(quarantineRoot, "accounts/local/ic-v1/log/abc");
      const entries = fs.readdirSync(parent);
      assert.ok(entries.length >= 2, "expected original quarantine dir plus uniquified copy");
      const alt = entries.find((name) => name !== "000000000000.enc");
      assert.ok(alt);
      assert.equal(
        fs.readFileSync(path.join(parent, alt, "000000000001.icgen")).toString(),
        "live-conflict",
      );
    });
  });

  describe("C1' file-level .icgen conflict copies", () => {
    async function seedLogSeg0(root) {
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
      await adapter.init();
      const writer = syncCtx(adapter, DEVICE_A);
      await objectStorePushSyncMutations(writer, [
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { tag: "c1prime" } },
        },
      ]);
      return { adapter, writer };
    }

    it("init rejects foreign file-level copy present before adapter open", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-c1p-init-pre-"));
      await seedLogSeg0(root);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      addForeignFileLevelCopy(root, key);
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
      await assert.rejects(
        () => adapter.init(),
        (err) => err instanceof StorageError && err.code === "corrupt_storage",
      );
    });

    it("pull raises corrupt_storage for foreign file-level copy (after init)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-c1p-pull-post-"));
      const { adapter } = await seedLogSeg0(root);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      addForeignFileLevelCopy(root, key);
      await assert.rejects(
        () =>
          objectStorePullSyncChanges(syncCtx(adapter, DEVICE_B), {
            since: normalizeVectorSyncCursor(0),
            limit: 50,
          }),
        (err) => err instanceof StorageError && err.code === "corrupt_storage",
      );
    });

    it("push raises corrupt_storage for foreign file-level copy (after init)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-c1p-push-post-"));
      const { adapter } = await seedLogSeg0(root);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      addForeignFileLevelCopy(root, key);
      await assert.rejects(
        () =>
          objectStorePushSyncMutations(syncCtx(adapter, DEVICE_A), [
            {
              client_id: generateClientNodeId(),
              op: "context_create",
              payload: { metadata: { tag: "push-after-foreign" } },
            },
          ]),
        (err) => err instanceof StorageError && err.code === "corrupt_storage",
      );
    });

    it("pull raises storage_fork for differing own-key file-level copies (after init)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-c1p-fork-"));
      const { adapter } = await seedLogSeg0(root);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(root, key);
      const gen = fs.readdirSync(keyDir).find((n) => n.endsWith(".icgen"));
      const alt = path.join(keyDir, gen.replace(".icgen", " 2.icgen"));
      fs.copyFileSync(path.join(keyDir, gen), alt);
      const buf = fs.readFileSync(alt);
      buf[buf.length - 4] ^= 0x55;
      fs.writeFileSync(alt, buf);
      await assert.rejects(
        () =>
          objectStorePullSyncChanges(syncCtx(adapter, DEVICE_B), {
            since: normalizeVectorSyncCursor(0),
            limit: 50,
          }),
        (err) =>
          err instanceof StorageError &&
          (err.code === "storage_fork" || err.code === "corrupt_storage"),
      );
    });
  });

  describe("T1 storage CLI unlock seam", () => {
    it("vault unlock fails fast without TTY when no passphrase flags", async () => {
      const { runVaultCli } = await import("../../src/cli/vault.mjs");
      setTestVaultContextProvider(() => ({
        me: { id: "user-test", email: "t@example.com" },
        crypto: { initialized: true, dek_version: 1, kdf_salt: Buffer.alloc(16).toString("base64"), wrapped_dek: Buffer.alloc(32).toString("base64") },
        accountKey: TEST_ACCOUNT_KEY,
        baseUrl: "http://127.0.0.1:9",
      }));
      const stdinIsTTY = process.stdin.isTTY;
      process.stdin.isTTY = false;
      await assert.rejects(
        () => runVaultCli(["unlock"]),
        (err) => /not a TTY|passphrase-stdin|passphrase-file/i.test(String(err?.message ?? err)),
      );
      process.stdin.isTTY = stdinIsTTY;
    });

    it("doctor --repair uses cached keychain DEK via real getUnlockedDek (no test env var)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-t1-cli-repair-"));
      writeConfigFile({
        baseUrl: "http://127.0.0.1:9",
        storage: { backend: "folder", folder: { path: root }, deviceUuid: DEVICE_A },
      });
      setTestVaultContextProvider(() => ({
        me: { id: "user-test", email: "t@example.com" },
        crypto: { initialized: true, dek_version: 1 },
        accountKey: TEST_ACCOUNT_KEY,
        baseUrl: "http://127.0.0.1:9",
      }));
      await storeUnlockedDek(TEST_ACCOUNT_KEY, DEK, { ttlMs: 60_000 });
      const adapter = createFolderStorageAdapter({ rootDir: root, placeholderTimeoutMs: 80 });
      await adapter.init();
      await objectStorePushSyncMutations(syncCtx(adapter, DEVICE_A), [
        {
          client_id: generateClientNodeId(),
          op: "context_create",
          payload: { metadata: { tag: "t1-cli" } },
        },
      ]);
      const key = logSegmentRelativePath(PREFIX, deriveDevH(DEK, DEVICE_A), 0);
      const { keyDir } = objectKeyDirectory(root, key);
      const conflictDir = path.join(path.dirname(keyDir), `${path.basename(keyDir)} 2`);
      fs.mkdirSync(conflictDir, { recursive: true, mode: 0o700 });
      fs.cpSync(keyDir, conflictDir, { recursive: true });
      const { runStorageCli } = await import("../../src/cli/storage-cli.mjs");
      await runStorageCli("doctor", ["--repair"]);
      assert.equal(fs.existsSync(conflictDir), false);
    });
  });
});
