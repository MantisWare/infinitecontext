import { resolveObjectStoreSyncBindingKey } from "../object-store-sync-binding.mjs";
import { createProductionObjectStoreLocalState } from "../object-store-sync-runtime.mjs";
import { ObjectStoreSyncTransport } from "./object-store-sync-transport.mjs";
import { createS3StorageAdapter } from "./s3-adapter.mjs";
import { resolveS3ObjectStoreConfig, S3_OBJECT_STORE_BACKEND_ID } from "./s3-config.mjs";
export { S3_OBJECT_STORE_BACKEND_ID };

/**
 * @param {{
 *   dek: Uint8Array,
 *   deviceUuid: string,
 *   layoutPrefix?: string,
 *   config?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   sync?: { mode?: "cli" | "daemon", persist?: boolean, cliStatePath?: string, dbPath?: string },
 *   localState?: { load: Function, save: Function },
 * }} options
 */
export async function createS3ObjectStore(options) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const s3 = resolveS3ObjectStoreConfig(config, env);
  const adapter = createS3StorageAdapter({
    bucket: s3.bucket,
    prefix: s3.prefix,
    region: s3.region,
    endpoint: s3.endpoint,
  });
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
      rootDir: `/${s3.bucket}/${s3.prefix}`,
      backendId: S3_OBJECT_STORE_BACKEND_ID,
    });
  }

  const bindingKey = resolveObjectStoreSyncBindingKey(config, env, {
    backendId: S3_OBJECT_STORE_BACKEND_ID,
    rootDir: `/${s3.bucket}/${s3.prefix}`,
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
    bucket: s3.bucket,
    prefix: s3.prefix,
    bindingKey,
    adapter,
    transport,
    localState,
    close: async () => {
      await adapter.close();
    },
  };
}
