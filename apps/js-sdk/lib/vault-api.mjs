import { getValidAccessToken } from "./credentials.mjs";

export async function fetchCryptoState({ baseUrl, fetchFn = fetch }) {
  const session = await getValidAccessToken({ baseUrl, fetchFn });
  if (!session?.accessToken) throw new Error("Not signed in. Run `infinitecontext login`.");
  const res = await fetchFn(`${session.baseUrl}/auth/crypto`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `Failed to load crypto state (${res.status})`));
  return body;
}

export async function uploadCryptoInit(payload, { baseUrl, fetchFn = fetch }) {
  const session = await getValidAccessToken({ baseUrl, fetchFn });
  if (!session?.accessToken) throw new Error("Not signed in. Run `infinitecontext login`.");
  const res = await fetchFn(`${session.baseUrl}/auth/crypto`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `Vault init failed (${res.status})`));
  return body;
}

export async function patchCryptoWraps(payload, { baseUrl, fetchFn = fetch }) {
  const session = await getValidAccessToken({ baseUrl, fetchFn });
  if (!session?.accessToken) throw new Error("Not signed in. Run `infinitecontext login`.");
  const res = await fetchFn(`${session.baseUrl}/auth/crypto`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `Vault update failed (${res.status})`));
  return body;
}

export async function fetchDevices({ baseUrl, fetchFn = fetch }) {
  const session = await getValidAccessToken({ baseUrl, fetchFn });
  if (!session?.accessToken) throw new Error("Not signed in. Run `infinitecontext login`.");
  const res = await fetchFn(`${session.baseUrl}/auth/devices`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `Failed to list devices (${res.status})`));
  return body;
}

export async function revokeDevice(sessionPublicId, { baseUrl, fetchFn = fetch }) {
  const session = await getValidAccessToken({ baseUrl, fetchFn });
  if (!session?.accessToken) throw new Error("Not signed in. Run `infinitecontext login`.");
  const res = await fetchFn(`${session.baseUrl}/auth/devices/${encodeURIComponent(sessionPublicId)}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `Failed to revoke device (${res.status})`));
  return body;
}

export async function fetchMe({ baseUrl, fetchFn = fetch }) {
  const session = await getValidAccessToken({ baseUrl, fetchFn });
  if (!session?.accessToken) throw new Error("Not signed in. Run `infinitecontext login`.");
  const res = await fetchFn(`${session.baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error ?? `Failed to load account (${res.status})`));
  return body;
}
