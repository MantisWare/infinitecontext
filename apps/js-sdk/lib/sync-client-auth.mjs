import { InfiniteContext } from "infinitecontext";
import { getValidAccessToken, hasSessionCredentials } from "./credentials.mjs";

export async function assertSyncAuth(cfg) {
  if (cfg.apiKey) return;
  if (!hasSessionCredentials()) {
    throw new Error("Missing account session. Run `infinitecontext login` or set INFINITECONTEXT_API_KEY.");
  }
  const session = await getValidAccessToken({ baseUrl: cfg.baseUrl });
  if (!session?.accessToken) {
    throw new Error("Session expired or invalid. Run `infinitecontext login`.");
  }
  const { assertVaultReadyForSync } = await import("./vault-require.mjs");
  await assertVaultReadyForSync({ baseUrl: cfg.baseUrl });
}

export function createInfiniteContextClient(cfg) {
  let baseClient;
  if (cfg.apiKey) {
    baseClient = new InfiniteContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  } else {
    baseClient = new InfiniteContext({
      baseUrl: cfg.baseUrl,
      getAccessToken: async () => {
        const session = await getValidAccessToken({ baseUrl: cfg.baseUrl });
        if (!session?.accessToken) {
          throw new Error("Session expired or invalid. Run `infinitecontext login`.");
        }
        return session.accessToken;
      },
    });
  }

  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args) => {
        const { getUnlockedDek } = await import("./vault-session.mjs");
        const { wrapInfiniteContextWithVault } = await import("./encrypted-client.mjs");
        const unlocked = cfg.apiKey ? null : await getUnlockedDek({ baseUrl: cfg.baseUrl });
        const client = unlocked ? wrapInfiniteContextWithVault(target, unlocked) : target;
        const fn = client[prop];
        if (typeof fn !== "function") return fn;
        return fn.apply(client, args);
      };
    },
  });
}
