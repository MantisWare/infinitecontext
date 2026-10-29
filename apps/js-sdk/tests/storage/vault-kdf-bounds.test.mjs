import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bytesToBase64, deriveVaultKekWithParams, randomBytes, wrapDek } from "../../lib/ic-crypto.mjs";
import {
  VAULT_KDF_MAX_ITERATIONS,
  VAULT_KDF_MAX_MEMORY_KIB,
  VAULT_KDF_MAX_PARALLELISM,
  VAULT_KDF_MIN_ITERATIONS,
  VAULT_KDF_MIN_MEMORY_KIB,
  decodeVaultJson,
  encodeVaultJson,
  parseStrictVaultKdfParams,
  unwrapDekFromVaultJson,
} from "../../lib/storage/layout.mjs";

const BASE_KDF = {
  algorithm: "argon2id",
  memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB,
  iterations: VAULT_KDF_MIN_ITERATIONS,
  parallelism: 4,
  hashLength: 32,
};

function vaultJsonWithKdf(kdf) {
  const salt = randomBytes(16);
  const kekPromise = deriveVaultKekWithParams("test-passphrase-12chars", salt, BASE_KDF);
  return kekPromise.then(async (kek) => {
    const wrapped = wrapDek(randomBytes(32), kek);
    return encodeVaultJson(wrapped, salt, kdf);
  });
}

describe("vault.json KDF bounds (QA #11)", () => {
  it("accepts floor and ceiling edges", () => {
    parseStrictVaultKdfParams({
      ...BASE_KDF,
      memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB,
      iterations: VAULT_KDF_MIN_ITERATIONS,
      parallelism: VAULT_KDF_MAX_PARALLELISM,
    });
    parseStrictVaultKdfParams({
      ...BASE_KDF,
      memorySizeKiB: VAULT_KDF_MAX_MEMORY_KIB,
      iterations: VAULT_KDF_MAX_ITERATIONS,
      parallelism: VAULT_KDF_MAX_PARALLELISM,
    });
  });

  it("rejects over-ceiling params before KDF runs", async () => {
    const cases = [
      { memorySizeKiB: 524_288, iterations: 3, parallelism: 4, match: /above ceiling.*256 MiB/ },
      { memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB, iterations: 11, parallelism: 4, match: /iterations above ceiling/ },
      { memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB, iterations: 100, parallelism: 4, match: /iterations above ceiling/ },
      { memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB, iterations: 3, parallelism: 9, match: /parallelism above ceiling/ },
    ];
    for (const row of cases) {
      const { match, ...kdf } = row;
      const started = performance.now();
      assert.throws(() => parseStrictVaultKdfParams({ ...BASE_KDF, ...kdf }), match);
      assert.ok(performance.now() - started < 100, "bounds check must be fast");
    }
    assert.throws(
      () =>
        parseStrictVaultKdfParams({
          ...BASE_KDF,
          memorySizeKiB: 524_288,
          iterations: 3,
        }),
      /above ceiling/,
    );
  });

  it("rejects string-typed numeric kdf fields", () => {
    assert.throws(
      () =>
        parseStrictVaultKdfParams({
          ...BASE_KDF,
          iterations: "3",
        }),
      /iterations must be a safe integer/,
    );
  });

  it("rejects under-floor params before KDF runs", async () => {
    const cases = [
      { memorySizeKiB: 32_768, iterations: 3, parallelism: 4, match: /below floor.*64 MiB/ },
      { memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB, iterations: 2, parallelism: 4, match: /iterations below floor/ },
      { memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB, iterations: 0, parallelism: 4, match: /iterations below floor/ },
      { memorySizeKiB: VAULT_KDF_MIN_MEMORY_KIB, iterations: 3, parallelism: 0, match: /parallelism below floor/ },
    ];
    for (const row of cases) {
      const { match, ...kdf } = row;
      assert.throws(() => parseStrictVaultKdfParams({ ...BASE_KDF, ...kdf }), match);
    }
    const salt = randomBytes(16);
    const kek = await deriveVaultKekWithParams("test-passphrase-12chars", salt, BASE_KDF);
    const wrapped = wrapDek(randomBytes(32), kek);
    const json = JSON.stringify({
      ic_vault_v: 1,
      kdf_salt_b64: bytesToBase64(salt),
      kdf: { ...BASE_KDF, memorySizeKiB: 8192, iterations: 1 },
      wrapped_dek_b64: bytesToBase64(wrapped),
    });
    await assert.rejects(() => unwrapDekFromVaultJson("test-passphrase-12chars", json), /below floor/);
  });
});
