import process from "node:process";
import readline from "node:readline/promises";

import { loadCredentials } from "../../lib/credentials.mjs";
import {
  DATA_LOSS_WARNING,
  changeVaultPassphrase,
  getVaultContext,
  initVault,
  lockVault,
  rotateVaultRecoveryKey,
  unlockVaultWithPassphrase,
  unlockVaultWithRecoveryKey,
} from "../../lib/vault-session.mjs";
import { fetchDevices, revokeDevice } from "../../lib/vault-api.mjs";
import { wrapInfiniteContextWithVault } from "../../lib/encrypted-client.mjs";
import { VAULT_AGENT_DOC } from "../../lib/vault-agent.mjs";

const DEFAULT_BASE_URL = "https://api.infinitecontext.ai";

function baseUrlFromArgs(argv) {
  const flag = argv.find((a) => a.startsWith("--base-url="));
  if (flag) return flag.slice("--base-url=".length);
  const creds = loadCredentials();
  return creds?.baseUrl ?? process.env.INFINITECONTEXT_BASE_URL ?? DEFAULT_BASE_URL;
}

async function promptHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let password = "";
    const onData = (chunk) => {
      const input = String(chunk);
      if (input.includes("\n") || input.includes("\r") || input.includes("\u0004")) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        if (password.trim().length === 0) {
          reject(new Error("Passphrase cannot be empty."));
          return;
        }
        resolve(password);
        return;
      }
      if (input === "\u0003") process.exit(130);
      for (const ch of input) {
        if (ch === "\u007f" || ch === "\b") password = password.slice(0, -1);
        else password += ch;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", reject);
  });
}

async function promptVisible(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function printVaultHelp() {
  console.log(`Usage: infinitecontext vault <command>

Commands:
  init                 Create vault crypto (shows recovery key once)
  unlock               Unlock vault (passphrase; use --recovery for recovery key)
  lock                 Clear cached DEK from memory/keychain
  status               Show vault initialization/unlock state
  change-passphrase    Re-wrap DEK with a new vault passphrase
  recover              Unlock using recovery key (alias for unlock --recovery)
  rotate-recovery-key  Generate a new recovery key (shown once)
  migrate-encrypt <id> Encrypt one plaintext context in place
  migrate-project      Encrypt all plaintext contexts (resumable state file)
    --dry-run          List contexts that still need encryption
  devices list         List signed-in devices
  devices revoke <id>  Revoke another device session

${VAULT_AGENT_DOC}

${DATA_LOSS_WARNING}
`);
}

async function cmdInit(baseUrl, argv) {
  console.log(DATA_LOSS_WARNING);
  console.log("");
  const googleOnly = argv.includes("--google-account");
  const passphrase = await promptHidden("Vault passphrase: ");
  const confirm = await promptHidden("Confirm vault passphrase: ");
  if (passphrase !== confirm) throw new Error("Passphrases do not match");
  const { recoveryKeyDisplay } = await initVault({
    baseUrl,
    passphrase,
    vaultPassphraseRequired: googleOnly,
  });
  console.log("\nSave this recovery key now. It will not be shown again:\n");
  console.log(recoveryKeyDisplay);
  console.log("");
  const typed = await promptVisible("Type the recovery key to confirm you saved it: ");
  const normalizeRecovery = (value) => value.replace(/[\s-]+/g, "").toUpperCase();
  if (normalizeRecovery(typed) !== normalizeRecovery(recoveryKeyDisplay)) {
    console.warn("Recovery key confirmation did not match. Vault is initialized; store the key from above.");
  } else {
    console.log("Vault initialized and unlocked.");
  }
}

async function cmdUnlock(baseUrl, argv) {
  const { crypto, accountKey } = await getVaultContext({ baseUrl });
  if (!crypto?.initialized) throw new Error("Vault not initialized. Run `infinitecontext vault init`.");
  if (argv.includes("--recovery")) {
    const key = await promptVisible("Recovery key: ");
    await unlockVaultWithRecoveryKey({ baseUrl, recoveryKey: key, accountKey, crypto });
  } else {
    const passphrase = await promptHidden("Vault passphrase: ");
    await unlockVaultWithPassphrase({ baseUrl, passphrase, accountKey, crypto });
  }
  console.log("Vault unlocked.");
}

async function cmdStatus(baseUrl) {
  const { crypto, accountKey } = await getVaultContext({ baseUrl });
  const { loadCachedDek } = await import("../../lib/vault-keychain.mjs");
  const cached = await loadCachedDek(accountKey);
  console.log(
    JSON.stringify(
      {
        initialized: Boolean(crypto?.initialized),
        unlocked: Boolean(cached),
        dek_version: crypto?.dek_version ?? null,
        vault_passphrase_required: crypto?.vault_passphrase_required ?? false,
      },
      null,
      2,
    ),
  );
}

async function buildEncryptedClient(baseUrl) {
  const { getUnlockedDek } = await import("../../lib/vault-session.mjs");
  const unlocked = await getUnlockedDek({ baseUrl });
  if (!unlocked) throw new Error("Vault is locked. Run `infinitecontext vault unlock`.");
  const { InfiniteContext } = await import("infinitecontext");
  return wrapInfiniteContextWithVault(
    new InfiniteContext({
      baseUrl,
      getAccessToken: async () => {
        const { getValidAccessToken } = await import("../../lib/credentials.mjs");
        const s = await getValidAccessToken({ baseUrl });
        return s.accessToken;
      },
    }),
    unlocked,
  );
}

async function cmdMigrateEncrypt(baseUrl, argv) {
  const contextId = argv.filter((a) => !a.startsWith("--"))[0];
  if (!contextId) throw new Error("Usage: infinitecontext vault migrate-encrypt <context-id>");
  const client = await buildEncryptedClient(baseUrl);
  await client.migrateEncryptContext(contextId);
  console.log(`Encrypted context ${contextId} in place.`);
}

async function cmdMigrateProject(baseUrl, argv) {
  const dryRun = argv.includes("--dry-run");
  const { InfiniteContext } = await import("infinitecontext");
  const tokenClient = new InfiniteContext({
    baseUrl,
    getAccessToken: async () => {
      const { getValidAccessToken } = await import("../../lib/credentials.mjs");
      const s = await getValidAccessToken({ baseUrl });
      return s.accessToken;
    },
  });
  const client = dryRun ? tokenClient : await buildEncryptedClient(baseUrl);
  const { migrateProjectEncryption } = await import("../../lib/vault-migrate.mjs");
  const { fetchMe } = await import("../../lib/vault-api.mjs");
  const me = await fetchMe({ baseUrl });
  const report = await migrateProjectEncryption({
    scopeKey: me.id,
    dryRun,
    listContexts: (opts) => tokenClient.get(opts),
    encryptContext: (id) => client.migrateEncryptContext(id),
  });
  console.log(JSON.stringify(report, null, 2));
}

export async function runVaultCli(argv) {
  const baseUrl = baseUrlFromArgs(argv).replace(/\/+$/, "");
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    printVaultHelp();
    return;
  }

  if (cmd === "init") return cmdInit(baseUrl, rest);
  if (cmd === "unlock") return cmdUnlock(baseUrl, rest);
  if (cmd === "recover") return cmdUnlock(baseUrl, [...rest, "--recovery"]);
  if (cmd === "lock") {
    const { accountKey } = await getVaultContext({ baseUrl });
    await lockVault(accountKey);
    console.log("Vault locked.");
    return;
  }
  if (cmd === "status") return cmdStatus(baseUrl);
  if (cmd === "change-passphrase") {
    const oldPass = await promptHidden("Current vault passphrase: ");
    const newPass = await promptHidden("New vault passphrase: ");
    await changeVaultPassphrase({ baseUrl, oldPassphrase: oldPass, newPassphrase: newPass });
    console.log("Vault passphrase updated (DEK re-wrapped).");
    return;
  }
  if (cmd === "rotate-recovery-key") {
    const passphrase = await promptHidden("Vault passphrase: ");
    const display = await rotateVaultRecoveryKey({ baseUrl, passphrase });
    console.log("\nNew recovery key (save now, shown once):\n");
    console.log(display);
    return;
  }
  if (cmd === "migrate-encrypt") return cmdMigrateEncrypt(baseUrl, rest);
  if (cmd === "migrate-project") return cmdMigrateProject(baseUrl, rest);
  if (cmd === "devices") {
    const [sub, id] = rest;
    if (sub === "list") {
      const body = await fetchDevices({ baseUrl });
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    if (sub === "revoke" && id) {
      await revokeDevice(id, { baseUrl });
      console.log("Device revoked.");
      return;
    }
    throw new Error("Usage: infinitecontext vault devices list|revoke <session-id>");
  }

  throw new Error(`Unknown vault command: ${cmd}`);
}
