import process from "node:process";

import { fetchDevices, revokeDevice } from "../../lib/vault-api.mjs";
import {
  fetchSyncStatus,
  pullSyncChanges,
  pushSyncMutations,
  fetchSyncConflicts,
} from "../../lib/sync-api.mjs";
import { flushSyncOutbox, getSyncCursor, pullAndApplySync } from "../../lib/sync-engine.mjs";
import { resolveBaseUrl } from "../../lib/client-config.mjs";
import { getValidAccessToken } from "../../lib/credentials.mjs";

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function requireSession(baseUrl) {
  const session = await getValidAccessToken({ baseUrl });
  if (!session?.accessToken) {
    throw new Error("Session expired or invalid. Run `infinitecontext login`.");
  }
}

export async function runSyncCli(subcommand, args) {
  const baseUrl = resolveBaseUrl();
  const cmd = String(subcommand ?? "help").toLowerCase();

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(`Usage: infinitecontext sync <command>

Commands:
  status     Server sync cursor + pending conflicts
  pull       Pull changes since local cursor (updates ~/.infinitecontext/sync-state.json)
  push       Flush local outbox via POST /sync/push (or pass JSON mutations file — advanced)
  devices    List registered devices (same as vault devices list)
  revoke     Revoke a device session (infinitecontext sync devices revoke <id>)

Environment:
  INFINITECONTEXT_BASE_URL   API base URL
`);
    return;
  }

  await requireSession(baseUrl);

  if (cmd === "status") {
    const localCursor = getSyncCursor();
    const remote = await fetchSyncStatus({ baseUrl });
    printJson({ local_cursor: localCursor, ...remote });
    return;
  }

  if (cmd === "pull") {
    const result = await pullAndApplySync({ baseUrl });
    const conflicts = await fetchSyncConflicts({ since: 0, baseUrl });
    printJson({ ...result, conflicts: conflicts.data ?? [] });
    return;
  }

  if (cmd === "push") {
    const flushed = await flushSyncOutbox({ baseUrl });
    printJson(flushed.result ?? { pushed: flushed.pushed });
    return;
  }

  if (cmd === "devices") {
    const nested = String(args[0] ?? "").toLowerCase();
    if (nested === "revoke") {
      const sessionId = args[1];
      if (!sessionId) throw new Error("Usage: infinitecontext sync devices revoke <session-public-id>");
      await revokeDevice(sessionId, { baseUrl });
      console.log("Device revoked.");
      return;
    }
    const devices = await fetchDevices({ baseUrl });
    printJson(devices);
    return;
  }

  throw new Error(`Unknown sync command: ${cmd}. Run infinitecontext sync help.`);
}
