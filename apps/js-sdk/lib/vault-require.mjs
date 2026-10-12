import { fetchCryptoState } from "./vault-api.mjs";
import { getUnlockedDek } from "./vault-session.mjs";
import { DATA_LOSS_WARNING } from "./vault-session.mjs";
import { isHostedApiBaseUrl, readConfigFile } from "./client-config.mjs";

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

async function promptYesNoRecommended({ question, defaultYes = true }) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    const trimmed = String(answer ?? "").trim().toLowerCase();
    if (!trimmed) return defaultYes;
    if (trimmed === "y" || trimmed === "yes") return true;
    if (trimmed === "n" || trimmed === "no") return false;
    return defaultYes;
  } finally {
    rl.close();
  }
}

export async function runInteractiveVaultInitIfRequired({
  baseUrl,
  googleAccount = false,
  hostedVaultRecommended = false,
}) {
  const { needsInit, crypto } = await fetchVaultGateState({ baseUrl });
  if (crypto?.initialized) return false;

  const hosted = isHostedApiBaseUrl(baseUrl);
  const config = readConfigFile();
  const recommendFromConfig = config.vaultInitRecommended !== false;
  const shouldOffer = needsInit || (hosted && (hostedVaultRecommended || recommendFromConfig));

  if (!shouldOffer) return false;

  if (hosted && !needsInit) {
    const yes = await promptYesNoRecommended({
      question:
        "\nInitialize zero-knowledge vault now? (recommended on hosted — run `infinitecontext vault init`)\n[Y/n]: ",
      defaultYes: recommendFromConfig,
    });
    if (!yes) return false;
  } else if (hosted && needsInit) {
    const yes = await promptYesNoRecommended({
      question:
        "\nThis account requires vault setup for encryption when vault is enabled. Initialize vault now?\n[Y/n]: ",
      defaultYes: true,
    });
    if (!yes) {
      console.log("Vault init skipped. Sync may fail until you run `infinitecontext vault init`.");
      return false;
    }
  }

  const { runVaultCli } = await import("../src/cli/vault.mjs");
  const initArgs = googleAccount ? ["init", "--google-account"] : ["init"];
  if (!needsInit) {
    console.log("\nVault encrypts context on your device (zero-knowledge when vault is enabled).\n");
  } else {
    console.log("\nVault setup is required for this account before syncing encrypted data.\n");
  }
  await runVaultCli(initArgs);
  return true;
}
