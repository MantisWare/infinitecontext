import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveBaseUrl } from "./client-config.mjs";

const CREDENTIALS_VERSION = 1;

/** @type {Promise<{ accessToken: string; baseUrl: string; credentials: object } | null> | null} */
let refreshInFlight = null;

export function infinitecontextHome() {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), ".infinitecontext");
}

export function credentialsPath() {
  return path.join(infinitecontextHome(), "credentials.json");
}

export function loadCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    if (Number(raw?.version) !== CREDENTIALS_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials) {
  const dir = infinitecontextHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort on platforms without chmod semantics
  }
  const filePath = credentialsPath();
  const payload = {
    version: CREDENTIALS_VERSION,
    ...credentials,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

export function clearCredentials() {
  try {
    fs.unlinkSync(credentialsPath());
  } catch {
    // ignore missing file
  }
}

function isExpired(iso) {
  if (!iso) return true;
  return Date.parse(iso) <= Date.now() + 30_000;
}

async function refreshAccessToken(resolvedBaseUrl, credentials, fetchFn) {
  const res = await fetchFn(`${resolvedBaseUrl}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: credentials.refreshToken }),
  });

  if (!res.ok) return null;
  const body = await res.json();
  const next = {
    ...credentials,
    baseUrl: resolvedBaseUrl,
    accessToken: String(body.access_token ?? ""),
    refreshToken: String(body.refresh_token ?? credentials.refreshToken),
    accessTokenExpiresAt: String(body.expires_at ?? ""),
    refreshTokenExpiresAt: String(body.refresh_expires_at ?? credentials.refreshTokenExpiresAt ?? ""),
  };
  saveCredentials(next);
  return { accessToken: next.accessToken, baseUrl: resolvedBaseUrl, credentials: next };
}

export async function getValidAccessToken({ baseUrl, fetchFn = fetch }) {
  const credentials = loadCredentials();
  if (!credentials?.refreshToken) return null;

  const resolvedBaseUrl = String(baseUrl ?? credentials.baseUrl ?? resolveBaseUrl()).replace(/\/+$/, "");
  if (!isExpired(credentials.accessTokenExpiresAt) && credentials.accessToken) {
    return {
      accessToken: String(credentials.accessToken),
      baseUrl: resolvedBaseUrl,
      credentials,
    };
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(resolvedBaseUrl, credentials, fetchFn).finally(() => {
      refreshInFlight = null;
    });
  }

  return refreshInFlight;
}

export function hasSessionCredentials() {
  const credentials = loadCredentials();
  return Boolean(credentials?.refreshToken);
}
