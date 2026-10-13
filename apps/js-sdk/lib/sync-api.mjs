import { getDefaultSyncTransport } from "./sync-transport.mjs";
import "./hosted-sync-transport.mjs";

export async function fetchSyncStatus(options = {}) {
  return getDefaultSyncTransport().fetchSyncStatus(options);
}

export async function pullSyncChanges(options = {}) {
  return getDefaultSyncTransport().pullSyncChanges(options);
}

export async function pushSyncMutations(mutations, options = {}) {
  return getDefaultSyncTransport().pushSyncMutations(mutations, options);
}

export async function fetchSyncConflicts(options = {}) {
  return getDefaultSyncTransport().fetchSyncConflicts(options);
}
