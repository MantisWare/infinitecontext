import { createSftpStorageAdapter, readSftpPrivateKeyFile } from "./sftp-adapter.mjs";
import { resolveSftpObjectStoreConfig } from "./sftp-config.mjs";
import { PreconditionFailedError, StorageError } from "./errors.mjs";
import { sampleEncryptedObjectBytesForKey } from "./contract-suite.mjs";

/**
 * @param {{
 *   config?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   secretStore?: import("./secret-store.mjs").SecretStore,
 *   adapterFactory?: typeof createSftpStorageAdapter,
 * }} [options]
 */
export async function runStorageDoctorSftp(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const sftp = resolveSftpObjectStoreConfig(config, env);
  const createAdapter = options.adapterFactory ?? createSftpStorageAdapter;

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const fixes = [];

  try {
    await import("ssh2-sftp-client");
  } catch {
    return {
      ok: false,
      backend: "sftp",
      error: "ssh2-sftp-client is not installed (npm i ssh2-sftp-client)",
      capabilities: null,
      fixes: ["Run: npm i ssh2-sftp-client"],
    };
  }

  if (sftp.privateKeyPath) {
    try {
      const { modeWarning } = readSftpPrivateKeyFile(sftp.privateKeyPath);
      if (modeWarning) {
        warnings.push(modeWarning);
        fixes.push(`chmod 600 ${sftp.privateKeyPath}`);
      }
    } catch (error) {
      return {
        ok: false,
        backend: "sftp",
        error: error instanceof Error ? error.message : String(error),
        capabilities: null,
        fixes: ["Fix storage.sftp.privateKeyPath"],
      };
    }
  }

  if (!sftp.hostKeySha256) {
    warnings.push("storage.sftp.hostKeySha256 is not set; known_hosts will be used (no TOFU)");
    fixes.push("Pin host key: ssh-keyscan -p <port> <host> | ssh-keygen -lf -");
  }

  /** @type {import("./sftp-adapter.mjs").createSftpStorageAdapter extends (...args: any) => infer R ? R : never} */
  let adapter;
  try {
    const authMaterial = await resolveSftpDoctorAuth(sftp, options.secretStore);
    adapter = createAdapter({
      host: sftp.host,
      port: sftp.port,
      username: sftp.username,
      root: sftp.root,
      hostKeySha256: sftp.hostKeySha256,
      knownHostsPath: sftp.hostKeySha256 ? undefined : sftp.knownHostsPath,
      ...authMaterial,
      agent: sftp.agent,
      timeoutMs: sftp.timeoutMs,
    });
    await adapter.init();
  } catch (error) {
    return {
      ok: false,
      backend: "sftp",
      error: error instanceof Error ? error.message : String(error),
      capabilities: null,
      warnings,
      fixes,
    };
  }

  const probe = adapter.sftpProbe?.() ?? null;
  const probeKey = `ic-doctor-probe-${Date.now()}`;
  const body = sampleEncryptedObjectBytesForKey(probeKey);
  try {
    await adapter.put(probeKey, body, { ifNoneMatch: "*" });
    let secondFailed = false;
    try {
      await adapter.put(probeKey, body, { ifNoneMatch: "*" });
    } catch (error) {
      secondFailed = error instanceof PreconditionFailedError;
    }
    if (!secondFailed) {
      warnings.push("create-exclusive probe: second create-only put succeeded (unexpected)");
    }
    await adapter.delete(probeKey);
  } catch (error) {
    warnings.push(`create-exclusive probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (probe && !probe.posixRenameExtension) {
    warnings.push(
      "posix-rename@openssh.com unavailable: only create-only writes are atomic; shared overwrites require lease locks",
    );
    fixes.push("Prefer OpenSSH sftp-server or pin a host that advertises posix-rename");
  }

  await adapter.close();

  return {
    ok: warnings.length === 0,
    backend: "sftp",
    host: sftp.host,
    port: sftp.port,
    root: sftp.root,
    capabilities: probe,
    warnings,
    fixes,
  };
}

/**
 * @param {ReturnType<typeof resolveSftpObjectStoreConfig>} sftp
 * @param {import("./secret-store.mjs").SecretStore | undefined} secretStore
 */
async function resolveSftpDoctorAuth(sftp, secretStore) {
  if (sftp.auth === "password") {
    if (!secretStore) {
      throw new StorageError("Secret store required for password auth", "invalid_argument");
    }
    const raw = await secretStore.get("storage.sftp.password");
    if (!raw) {
      throw new StorageError("storage.sftp.password missing from secret store", "invalid_argument");
    }
    return { password: new TextDecoder().decode(raw) };
  }
  if (sftp.privateKeyPath) {
    const { key } = readSftpPrivateKeyFile(sftp.privateKeyPath);
    /** @type {{ privateKey: Buffer, passphrase?: string }} */
    const out = { privateKey: key };
    if (secretStore) {
      const pass = await secretStore.get("storage.sftp.keyPassphrase");
      if (pass) {
        out.passphrase = new TextDecoder().decode(pass);
      }
    }
    return out;
  }
  return { agent: sftp.agent };
}
