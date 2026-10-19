import { resolveSftpEmuConfigFromEnv, stopSftpEmuContainer } from "./sftp-emu.mjs";

/** @type {ReturnType<typeof resolveSftpEmuConfigFromEnv> | undefined} */
let cached;

export function getSftpEmuConfig() {
  if (cached === undefined) {
    cached = resolveSftpEmuConfigFromEnv();
  }
  return cached;
}

export function teardownSftpEmu() {
  if (cached?.containerName) {
    stopSftpEmuContainer(cached.containerName);
  }
  cached = undefined;
}
