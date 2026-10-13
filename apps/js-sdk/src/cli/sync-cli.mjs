import process from "node:process";

import { fetchDevices, revokeDevice } from "../../lib/vault-api.mjs";
import {
  fetchSyncStatus,
  pullSyncChanges,
  pushSyncMutations,
  fetchSyncConflicts,
} from "../../lib/sync-api.mjs";
import {
  createCliSyncStore,
  dropParkedFailure,
  flushSyncOutbox,
  getSyncCursor,
  listParkedFailures,
  pullAndApplySync,
  readLocalSyncState,
  retryParkedFailure,
} from "../../lib/sync-engine.mjs";
import { resolveBaseUrl } from "../../lib/client-config.mjs";
import { getValidAccessToken } from "../../lib/credentials.mjs";
import { formatSyncCliError } from "../../lib/sync-errors.mjs";

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

  const run = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      const msg = formatSyncCliError(error);
      if (msg !== error?.message) {
        console.error(msg);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  };

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(`Usage: infinitecontext sync <command>

Commands:
  status     Server sync cursor + pending conflicts
  pull       Pull changes since CLI cursor (~/.infinitecontext/sync-cli-state.json)
  push       Flush local outbox via POST /sync/push (or pass JSON mutations file — advanced)
  parked     list | retry <client_id> | drop <client_id>  — manage parked push failures
  devices    List registered devices (same as vault devices list)
  revoke     Revoke a device session (infinitecontext sync devices revoke <id>)

Environment:
  INFINITECONTEXT_BASE_URL   API base URL
`);
    return;
  }

  await requireSession(baseUrl);

  if (cmd === "status") {
    return run(async () => {
      const local = readLocalSyncState();
      const remote = await fetchSyncStatus({ baseUrl });
      printJson({
        local_cursor: local.cursor,
        outbox_count: local.outbox.length,
        parked_failures: local.parked_failures,
        ...remote,
      });
    });
  }

  if (cmd === "pull") {
    return run(async () => {
      const result = await pullAndApplySync({ baseUrl, store: createCliSyncStore() });
      const conflicts = await fetchSyncConflicts({ since: 0, baseUrl });
      printJson({ ...result, conflicts: conflicts.data ?? [] });
    });
  }

  if (cmd === "push") {
    return run(async () => {
      const flushed = await flushSyncOutbox({ baseUrl });
      printJson(flushed.result ?? { pushed: flushed.pushed });
    });
  }

  if (cmd === "parked") {
    const sub = String(args[0] ?? "list").toLowerCase();
    if (sub === "list") {
      printJson({ parked_failures: listParkedFailures() });
      return;
    }
    if (sub === "retry") {
      const clientId = args[1];
      if (!clientId) throw new Error("Usage: infinitecontext sync parked retry <client_id>");
      const ok = retryParkedFailure(clientId);
      if (!ok) throw new Error(`No parked failure for client_id ${clientId}`);
      console.log("Moved parked mutation back to the outbox.");
      return;
    }
    if (sub === "drop") {
      const clientId = args[1];
      if (!clientId) throw new Error("Usage: infinitecontext sync parked drop <client_id>");
      if (!dropParkedFailure(clientId)) throw new Error(`No parked failure for client_id ${clientId}`);
      console.log("Dropped parked failure.");
      return;
    }
    throw new Error(`Unknown parked subcommand: ${sub}. Use list, retry, or drop.`);
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
