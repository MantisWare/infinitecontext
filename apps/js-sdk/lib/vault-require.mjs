import { fetchCryptoState } from "./vault-api.mjs";
import { getUnlockedDek } from "./vault-session.mjs";
import { DATA_LOSS_WARNING } from "./vault-session.mjs";

export async function fetchVaultGateState({ baseUrl }) {
  const crypto = await fetchCryptoState({ baseUrl });
  const needsInit =
    Boolean(crypto?.vault_passphrase_required) && !crypto?.initialized;
  const needsUnlock = Boolean(crypto?.initialized) && !(await getUnlockedDek({ baseUrl }));
  return { crypto, needsInit, needsUnlock };
}

export async function assertVaultReadyForSync({ baseUrl }) {
  const { needsInit, needsUnlock } = await fetchVaultGateState({ baseUrl });
  if (needsInit) {
    throw new Error(
      "Vault setup required before sync. Run `infinitecontext vault init` and save your recovery key.\n" +
        DATA_LOSS_WARNING,
    );
  }
  if (needsUnlock) {
    throw new Error("Vault is locked. Run `infinitecontext vault unlock` (or `vault recover`).");
  }
}

export async function runInteractiveVaultInitIfRequired({ baseUrl, googleAccount = false }) {
  const { needsInit } = await fetchVaultGateState({ baseUrl });
  if (!needsInit) return false;
  const { runVaultCli } = await import("../src/cli/vault.mjs");
  const initArgs = googleAccount ? ["init", "--google-account"] : ["init"];
  console.log("\nVault setup is required for this account before syncing encrypted data.\n");
  await runVaultCli(initArgs);
  return true;
}
