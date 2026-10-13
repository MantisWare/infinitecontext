export class SyncApiUnavailableError extends Error {
  constructor(message, code = "sync_api_unavailable") {
    super(message);
    this.name = "SyncApiUnavailableError";
    this.status = 503;
    this.code = code;
  }
}

export function formatSyncCliError(error) {
  if (error?.code === "sync_api_unavailable" || error?.name === "SyncApiUnavailableError") {
    return (
      "Centralized sync is not available on this API deployment.\n" +
      "Sync requires a PostgreSQL-backed hosted API (Node server). " +
      "Cloudflare Workers + Supabase REST do not support /sync yet.\n" +
      "Use `infinitecontext config show` to confirm base URL, or self-host the Node API with Postgres."
    );
  }
  return error?.message ?? String(error);
}
