import { InfiniteContext } from "infinitecontext";
import { getValidAccessToken, hasSessionCredentials } from "infinitecontext/credentials";

export async function assertSyncAuth(cfg) {
  if (cfg.apiKey) return;
  if (!hasSessionCredentials()) {
    throw new Error("Missing account session. Run `infinitecontext login` or set INFINITECONTEXT_API_KEY.");
  }
  const session = await getValidAccessToken({ baseUrl: cfg.baseUrl });
  if (!session?.accessToken) {
    throw new Error("Session expired or invalid. Run `infinitecontext login`.");
  }
}

export function createInfiniteContextClient(cfg) {
  if (cfg.apiKey) {
    return new InfiniteContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  }
  return new InfiniteContext({
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
