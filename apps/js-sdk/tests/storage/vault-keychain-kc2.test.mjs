import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  clearVaultKeychainBackendForTests,
  setVaultKeychainBackendForTests,
} from "../../lib/vault-keychain-inject.mjs";
import {
  assertVaultUnlockPersisted,
  clearVaultKeychainCache,
  loadCachedDek,
  storeUnlockedDek,
} from "../../lib/vault-keychain.mjs";

describe("KC2 keytar getPassword timeout falls through to vault agent", () => {
  afterEach(async () => {
    clearVaultKeychainBackendForTests();
    await clearVaultKeychainCache("acct-kc2");
  });

  it("reloads from vault agent when getPassword hangs (keytar timeout)", async () => {
    /** @type {string | null} */
    let keychainPayload = null;
    setVaultKeychainBackendForTests({
      setPassword: async (_service, _account, password) => {
        keychainPayload = password;
      },
      getPassword: () => new Promise(() => {}),
      deletePassword: async () => true,
    });
    const dek = new Uint8Array(32).fill(9);
    await storeUnlockedDek("acct-kc2", dek, { ttlMs: 60_000 });
    assert.ok(keychainPayload);
    const loaded = await loadCachedDek("acct-kc2");
    assert.deepEqual([...loaded], [...dek]);
    await assertVaultUnlockPersisted("acct-kc2");
  });
});
