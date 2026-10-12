/** Minimal API client for standalone sync when the infinitecontext CLI package is not installed. */

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function createApiKeyClient(cfg) {
  const baseUrl = String(cfg.baseUrl ?? "").replace(/\/+$/, "");
  const apiKey = String(cfg.apiKey ?? "").trim();

  return {
    async get({ limit = 1 } = {}) {
      const res = await fetch(`${baseUrl}/contexts?limit=${limit}`, { headers: authHeaders(apiKey) });
      const body = await readJson(res);
      if (!res.ok) {
        const err = new Error(String(body.error ?? `Request failed (${res.status})`));
        err.status = res.status;
        throw err;
      }
      return body;
    },
    async create({ metadata } = {}) {
      const res = await fetch(`${baseUrl}/contexts`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(metadata ? { metadata } : {}),
      });
      const body = await readJson(res);
      if (!res.ok) {
        const err = new Error(String(body.error ?? `Request failed (${res.status})`));
        err.status = res.status;
        throw err;
      }
      return body;
    },
    async append(contextId, payload) {
      const bodyPayload = Array.isArray(payload) ? payload : [payload];
      const res = await fetch(`${baseUrl}/contexts/${contextId}`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(bodyPayload.length === 1 ? bodyPayload[0] : bodyPayload),
      });
      const body = await readJson(res);
      if (!res.ok) {
        const err = new Error(String(body.error ?? `Request failed (${res.status})`));
        err.status = res.status;
        throw err;
      }
      return body;
    },
  };
}

export async function assertSyncAuth(cfg) {
  if (cfg.apiKey) return;
  throw new Error(
    "Account login requires the infinitecontext CLI package. Set INFINITECONTEXT_API_KEY or install infinitecontext.",
  );
}

export function createInfiniteContextClient(cfg) {
  if (!cfg.apiKey) {
    throw new Error("INFINITECONTEXT_API_KEY is required when running sync without the infinitecontext CLI package.");
  }
  return createApiKeyClient(cfg);
}
