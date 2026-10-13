import { pushSyncMutations } from "./sync-api.mjs";
import { mutationForContextCreate, mutationForMessageAppend } from "./sync-engine.mjs";

/**
 * Account-mode transport: create/append via POST /sync/push (idempotent icn_* mutations).
 * Reads (get/list) stay on /contexts for TUI/MCP; daemon pull uses /sync/changes separately.
 */
export function wrapInfiniteContextWithSyncPush(client, { baseUrl } = {}) {
  return {
    ...client,
    async create(input = {}) {
      const mutation = {
        ...mutationForContextCreate(input.metadata ?? {}),
        op: input.from ? "context_fork" : "context_create",
        payload: {
          from: input.from,
          version: input.version,
          at: input.at,
          before: input.before,
          metadata: input.metadata ?? {},
        },
      };
      const result = await pushSyncMutations([mutation], { baseUrl });
      const effect = result.effects?.find((e) => e.client_id === mutation.client_id) ?? result.effects?.[0];
      const contextId = effect?.context_id ?? "";
      if (!contextId) {
        throw new Error("Sync push did not return a context id");
      }
      if (typeof client.get === "function") {
        try {
          const listed = await client.get({ limit: 1 });
          const row = listed?.data?.find((c) => c.id === contextId);
          if (row) {
            return { id: contextId, metadata: row.metadata ?? {}, created_at: row.created_at };
          }
        } catch {
          // fall through
        }
      }
      return { id: contextId, metadata: input.metadata ?? {}, created_at: new Date().toISOString() };
    },

    async append(contextId, input) {
      const list = Array.isArray(input) ? input : [input];
      const mutation = mutationForMessageAppend(contextId, list);
      const result = await pushSyncMutations([mutation], { baseUrl });
      const version = result.effects?.find((e) => e.client_id === mutation.client_id)?.version ?? 0;
      const data = list.map((msg, index) => {
        const id =
          typeof msg.id === "string"
            ? msg.id
            : typeof msg.metadata?.ic_client_node_id === "string"
              ? msg.metadata.ic_client_node_id
              : mutation.client_id;
        return {
          ...msg,
          id,
          index,
          metadata: msg.metadata ?? {},
        };
      });
      return { data, version };
    },
  };
}
