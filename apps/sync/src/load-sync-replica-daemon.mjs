import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @returns {Promise<typeof import("../../js-sdk/lib/sync-replica-daemon-store.mjs")>} */
export async function loadSyncReplicaDaemonModule() {
  try {
    return await import("infinitecontext/lib/sync-replica-daemon-store.mjs");
  } catch {
    const sdkLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../js-sdk/lib");
    return import(pathToFileURL(path.join(sdkLib, "sync-replica-daemon-store.mjs")).href);
  }
}
