import { getValidAccessToken } from "./credentials.mjs";
import { resolveBaseUrl } from "./client-config.mjs";

async function authHeaders(baseUrl) {
  const session = await getValidAccessToken({ baseUrl });
  if (!session?.accessToken) {
    throw new Error("Session expired or invalid. Run `infinitecontext login`.");
  }
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  };
}

async function syncRequest(baseUrl, path, init = {}) {
  const headers = await authHeaders(baseUrl);
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(body.error ?? `Sync request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function fetchSyncStatus(options = {}) {
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  return syncRequest(baseUrl, "/sync/status", { method: "GET" });
}

export async function pullSyncChanges({ since = 0, limit, baseUrl } = {}) {
  const url = baseUrl ?? resolveBaseUrl();
  const params = new URLSearchParams({ since: String(since) });
  if (limit !== undefined) params.set("limit", String(limit));
  return syncRequest(url, `/sync/changes?${params.toString()}`, { method: "GET" });
}

export async function pushSyncMutations(mutations, options = {}) {
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  return syncRequest(baseUrl, "/sync/push", {
    method: "POST",
    body: JSON.stringify({ mutations }),
  });
}

export async function fetchSyncConflicts({ since = 0, limit = 200, baseUrl } = {}) {
  const url = baseUrl ?? resolveBaseUrl();
  const params = new URLSearchParams({ since: String(since), limit: String(limit) });
  return syncRequest(url, `/sync/conflicts?${params.toString()}`, { method: "GET" });
}
