import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  clearVaultKeychainBackendForTests,
  setVaultKeychainBackendForTests,
} from "../../lib/vault-keychain-inject.mjs";
import {
  assertVaultUnlockPersisted,
  clearVaultKeychainCache,
  storeUnlockedDek,
} from "../../lib/vault-keychain.mjs";

describe("KC1 loadCachedDek keytar miss falls through to vault agent", () => {
  afterEach(async () => {
    clearVaultKeychainBackendForTests();
    await clearVaultKeychainCache("acct-kc1");
  });

  it("reloads from vault agent when keytar has no entry", async () => {
    setVaultKeychainBackendForTests({
      setPassword: async () => {
        throw new Error("keytar write unavailable");
      },
      getPassword: async () => null,
      deletePassword: async () => true,
    });
    const dek = new Uint8Array(32).fill(7);
    await storeUnlockedDek("acct-kc1", dek, { ttlMs: 60_000 });
    await assertVaultUnlockPersisted("acct-kc1");
  });
});
