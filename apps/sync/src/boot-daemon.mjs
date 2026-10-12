import { createStore, resolveDbPath } from "./store.mjs";
import { daemonBoot } from "./daemon.mjs";
import { resolveHostAuthHooks } from "./host-auth.mjs";

export async function bootSyncDaemonFromSource() {
  const auth = await resolveHostAuthHooks();
  await daemonBoot({ createStore, resolveDbPath, ...auth });
}
