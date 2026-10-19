import { resolveObjectStoreSyncBindingKey } from "../object-store-sync-binding.mjs";
import { createProductionObjectStoreLocalState } from "../object-store-sync-runtime.mjs";
import { ObjectStoreSyncTransport } from "./object-store-sync-transport.mjs";
import { createSftpStorageAdapter, readSftpPrivateKeyFile } from "./sftp-adapter.mjs";
import { resolveSftpObjectStoreConfig, SFTP_OBJECT_STORE_BACKEND_ID } from "./sftp-config.mjs";
import { SecretStore } from "./secret-store.mjs";

export { SFTP_OBJECT_STORE_BACKEND_ID };

/**
 * @param {{
 *   dek: Uint8Array,
 *   deviceUuid: string,
 *   layoutPrefix?: string,
 *   config?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   sync?: { mode?: "cli" | "daemon", persist?: boolean, cliStatePath?: string, dbPath?: string },
 *   localState?: { load: Function, save: Function },
 *   secretStore?: SecretStore,
 * }} options
 */
export async function createSftpObjectStore(options) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const sftp = resolveSftpObjectStoreConfig(config, env);
  const secretStore = options.secretStore ?? new SecretStore();

  /** @type {string | undefined} */
  let password;
  /** @type {string | undefined} */
  let passphrase;
  if (sftp.auth === "password") {
    const raw = await secretStore.get("storage.sftp.password");
    if (!raw) {
      throw new Error("storage.sftp.password missing from secret store");
    }
    password = new TextDecoder().decode(raw);
  }
  if (sftp.auth === "key" && sftp.privateKeyPath) {
    const raw = await secretStore.get("storage.sftp.keyPassphrase");
    if (raw) {
      passphrase = new TextDecoder().decode(raw);
    }
  }

  /** @type {Parameters<typeof createSftpStorageAdapter>[0]} */
  const adapterOpts = {
    host: sftp.host,
    port: sftp.port,
    username: sftp.username,
    root: sftp.root,
    hostKeySha256: sftp.hostKeySha256,
    knownHostsPath: sftp.hostKeySha256 ? undefined : sftp.knownHostsPath,
    passphrase,
    password,
    agent: sftp.agent,
    timeoutMs: sftp.timeoutMs,
  };
  if (sftp.privateKeyPath) {
    adapterOpts.privateKey = readSftpPrivateKeyFile(sftp.privateKeyPath).key;
  }
  const adapter = createSftpStorageAdapter(adapterOpts);
  await adapter.init();

  const persist = options.sync?.persist !== false;
  const localState =
    options.localState ??
    (persist && options.dek && options.deviceUuid
      ? createProductionObjectStoreLocalState({
          mode: options.sync?.mode,
          cliStatePath: options.sync?.cliStatePath,
          dbPath: options.sync?.dbPath,
          env,
        })
      : null);

  if (localState) {
    const { maybeRebindPersistedObjectStoreState } = await import("../object-store-sync-state-rebind.mjs");
    await maybeRebindPersistedObjectStoreState(localState, config, env, {
      backendId: SFTP_OBJECT_STORE_BACKEND_ID,
    });
  }

  const bindingKey = resolveObjectStoreSyncBindingKey(config, env, {
    backendId: SFTP_OBJECT_STORE_BACKEND_ID,
  });

  const transport = new ObjectStoreSyncTransport(
    adapter,
    options.dek && options.deviceUuid && localState
      ? {
          dek: options.dek,
          deviceUuid: options.deviceUuid,
          layoutPrefix: options.layoutPrefix ?? "accounts/local",
          localState,
        }
      : undefined,
  );

  return {
    root: sftp.root,
    bindingKey,
    adapter,
    transport,
    localState,
    close: async () => {
      await adapter.close();
    },
  };
}
