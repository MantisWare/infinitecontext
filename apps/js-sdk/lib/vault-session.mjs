import {
  assertVaultPassphrase,
  computeDekProof,
  createVaultCryptoMaterial,
  decodeRecoveryKey,
  deriveVaultKek,
  dekProofToBase64,
  rewrapDekWithNewPassphrase,
  recoveryKeyToKek,
  rotateRecoveryWrap,
  unwrapDek,
  randomBytes,
} from "./ic-crypto.mjs";

import {
  clearVaultKeychainCache,
  defaultVaultTtlMs,
  loadCachedDek,
  storeUnlockedDek,
  vaultAccountKey,
} from "./vault-keychain.mjs";
import { fetchCryptoState, patchCryptoWraps, uploadCryptoInit } from "./vault-api.mjs";

export const DATA_LOSS_WARNING =
  "If you lose BOTH your vault passphrase and your recovery key, your encrypted context data is permanently unrecoverable. InfiniteContext cannot reset or restore it.";

export async function getVaultContext({ baseUrl }) {
  const me = await import("./vault-api.mjs").then((m) => m.fetchMe({ baseUrl }));
  const crypto = await fetchCryptoState({ baseUrl });
  const accountKey = vaultAccountKey({ userPublicId: me.id, email: me.email });
  return { me, crypto, accountKey, baseUrl };
}

export async function unlockVaultWithPassphrase({ baseUrl, passphrase, accountKey, crypto }) {
  if (!crypto?.initialized) throw new Error("Vault is not initialized. Run `infinitecontext vault init`.");
  assertVaultPassphrase(passphrase);
  const salt = Buffer.from(String(crypto.kdf_salt ?? ""), "base64");
  const wrapped = Buffer.from(String(crypto.wrapped_dek ?? ""), "base64");
  const kek = await deriveVaultKek(passphrase, new Uint8Array(salt));
  const dek = unwrapDek(new Uint8Array(wrapped), kek);
  await storeUnlockedDek(accountKey, dek, { ttlMs: defaultVaultTtlMs() });
  return dek;
}

export async function unlockVaultWithRecoveryKey({ baseUrl, recoveryKey, accountKey, crypto }) {
  if (!crypto?.initialized) throw new Error("Vault is not initialized.");
  const wrapped = Buffer.from(String(crypto.wrapped_dek_recovery ?? ""), "base64");
  const kek = recoveryKeyToKek(decodeRecoveryKey(recoveryKey));
  const dek = unwrapDek(new Uint8Array(wrapped), kek);
  await storeUnlockedDek(accountKey, dek, { ttlMs: defaultVaultTtlMs() });
  return dek;
}

export async function getUnlockedDek({ baseUrl }) {
  const { me, accountKey, crypto } = await getVaultContext({ baseUrl });
  if (!crypto?.initialized) return null;
  let cached;
  try {
    cached = await loadCachedDek(accountKey);
  } catch {
    return null;
  }
  if (!cached) return null;
  return {
    dek: cached,
    accountKey,
    crypto,
    dekVersion: crypto.dek_version ?? 1,
    userPublicId: me.id,
  };
}

export async function lockVault(accountKey) {
  await clearVaultKeychainCache(accountKey);
  const { vaultAgentShutdown } = await import("./vault-agent.mjs");
  await vaultAgentShutdown();
}

export async function initVault({ baseUrl, passphrase, vaultPassphraseRequired = false }) {
  assertVaultPassphrase(passphrase);
  const material = await createVaultCryptoMaterial(passphrase);
  const dekProof = Buffer.from(computeDekProof(material.dek)).toString("base64");
  await uploadCryptoInit(
    {
      kdf_salt: Buffer.from(material.kdfSalt).toString("base64"),
      kdf_params: material.kdfParams,
      wrapped_dek: Buffer.from(material.wrappedDekPassphrase).toString("base64"),
      wrapped_dek_recovery: Buffer.from(material.wrappedDekRecovery).toString("base64"),
      dek_proof: dekProof,
      dek_version: material.dekVersion,
      vault_passphrase_required: vaultPassphraseRequired,
    },
    { baseUrl },
  );
  const { accountKey } = await getVaultContext({ baseUrl });
  await storeUnlockedDek(accountKey, material.dek, { ttlMs: defaultVaultTtlMs() });
  return {
    recoveryKeyDisplay: material.recoveryKeyDisplay,
    recoveryKeyBytes: material.recoveryKeyBytes,
  };
}

export function buildCryptoPatchPayload({ crypto, dek, partial }) {
  const dekProof = Buffer.from(computeDekProof(dek)).toString("base64");
  return {
    dek_proof: dekProof,
    expected_wrapped_dek: crypto.wrapped_dek,
    expected_wrapped_dek_recovery: crypto.wrapped_dek_recovery,
    ...partial,
  };
}

export async function changeVaultPassphrase({ baseUrl, oldPassphrase, newPassphrase }) {
  assertVaultPassphrase(newPassphrase);
  const { crypto, accountKey } = await getVaultContext({ baseUrl });
  const dek = await unlockVaultWithPassphrase({ baseUrl, passphrase: oldPassphrase, accountKey, crypto });
  const rewrapped = await rewrapDekWithNewPassphrase({ dek, newPassphrase });
  await patchCryptoWraps(
    buildCryptoPatchPayload({
      crypto,
      dek,
      partial: {
        wrapped_dek: Buffer.from(rewrapped.wrappedDek).toString("base64"),
        kdf_salt: Buffer.from(rewrapped.kdfSalt).toString("base64"),
      },
    }),
    { baseUrl },
  );
  await storeUnlockedDek(accountKey, dek, { ttlMs: defaultVaultTtlMs() });
}

export async function rotateVaultRecoveryKey({ baseUrl, passphrase }) {
  const { crypto, accountKey } = await getVaultContext({ baseUrl });
  const dek = await unlockVaultWithPassphrase({ baseUrl, passphrase, accountKey, crypto });
  const newRecoveryBytes = randomBytes(32);
  const rotated = await rotateRecoveryWrap({ dek, newRecoveryKeyBytes: newRecoveryBytes });
  await patchCryptoWraps(
    buildCryptoPatchPayload({
      crypto,
      dek,
      partial: {
        wrapped_dek_recovery: Buffer.from(rotated.wrappedDekRecovery).toString("base64"),
      },
    }),
    { baseUrl },
  );
  return rotated.recoveryKeyDisplay;
}

export { dekProofToBase64 };
