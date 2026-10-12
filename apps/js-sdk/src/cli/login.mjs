import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import process from "node:process";
import readline from "node:readline/promises";

import { saveCredentials } from "./credentials.mjs";

const DEFAULT_BASE_URL = "https://api.infinitecontext.ai";
const LOCAL_CALLBACK_PORT = 53682;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "")));
  return {
    google: flags.has("google"),
    localhost: flags.has("localhost"),
    email: argv.find((a) => a.startsWith("--email="))?.split("=")[1] ?? process.env.INFINITECONTEXT_LOGIN_EMAIL ?? "",
    password: argv.find((a) => a.startsWith("--password="))?.split("=")[1] ?? process.env.INFINITECONTEXT_LOGIN_PASSWORD ?? "",
    baseUrl: argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? process.env.INFINITECONTEXT_BASE_URL ?? DEFAULT_BASE_URL,
  };
}

async function promptHidden(question) {
  if (process.env.INFINITECONTEXT_LOGIN_PASSWORD) return process.env.INFINITECONTEXT_LOGIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer;
  } finally {
    rl.close();
  }
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }
  if (!res.ok) {
    throw new Error(String(parsed.error ?? `Request failed (${res.status})`));
  }
  return parsed;
}

function persistTokens(baseUrl, body, extra = {}) {
  saveCredentials({
    baseUrl,
    email: extra.email ?? null,
    accessToken: String(body.access_token ?? ""),
    refreshToken: String(body.refresh_token ?? ""),
    accessTokenExpiresAt: String(body.expires_at ?? ""),
    refreshTokenExpiresAt: String(body.refresh_expires_at ?? ""),
    deviceId: extra.deviceId ?? null,
  });
}

async function loginWithPassword({ baseUrl, email, password }) {
  const resolvedEmail = email || (await promptHidden("Email: "));
  const resolvedPassword = password || (await promptHidden("Password: "));
  const body = await postJson(baseUrl, "/auth/login", {
    email: resolvedEmail,
    password: resolvedPassword,
    device_id: deviceId(),
    device_name: deviceName(),
  });
  persistTokens(baseUrl, body, { email: resolvedEmail });
  console.log(`Signed in as ${resolvedEmail}`);
}

async function loginWithGoogleDevice(baseUrl) {
  const started = await postJson(baseUrl, "/auth/oauth/google/device/start", {});
  console.log(`Open ${started.verification_url} and enter code: ${started.user_code}`);
  const intervalMs = Math.max(2, Number(started.interval ?? 2)) * 1000;

  for (;;) {
    await sleep(intervalMs);
    const res = await fetch(`${baseUrl}/auth/oauth/google/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: started.device_code, device_id: deviceId(), device_name: deviceName() }),
    });
    const body = await res.json();
    if (res.status === 202) continue;
    if (!res.ok) throw new Error(String(body.error ?? `Google device poll failed (${res.status})`));
    persistTokens(baseUrl, body, { email: body.user?.email ?? null });
    console.log(`Signed in with Google as ${body.user?.email ?? body.user?.id ?? "account"}`);
    return;
  }
}

function generatePkceVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

async function pkceChallenge(verifier) {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return digest.toString("base64url");
}

function generateOAuthState() {
  return crypto.randomBytes(24).toString("base64url");
}

async function loginWithGoogleLocalhost(baseUrl) {
  const redirectUri = `http://127.0.0.1:${LOCAL_CALLBACK_PORT}/callback`;
  const expectedState = generateOAuthState();
  const codeVerifier = generatePkceVerifier();
  const codeChallenge = await pkceChallenge(codeVerifier);
  const codePromise = waitForOAuthCallback(LOCAL_CALLBACK_PORT, expectedState);
  const authorizeUrl = `${baseUrl}/auth/oauth/google/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(expectedState)}&code_challenge=${encodeURIComponent(codeChallenge)}`;
  console.log(`Opening browser flow: ${authorizeUrl}`);
  try {
    const open = (await import("node:child_process")).spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [authorizeUrl], { stdio: "ignore" });
    if (open.error) {
      console.log("Open the URL above in your browser to continue.");
    }
  } catch {
    console.log("Open the URL above in your browser to continue.");
  }

  const { code } = await codePromise;
  const body = await postJson(baseUrl, "/auth/oauth/google/callback", {
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    device_id: deviceId(),
    device_name: deviceName(),
  });
  persistTokens(baseUrl, body, { email: body.user?.email ?? null });
  console.log(`Signed in with Google as ${body.user?.email ?? body.user?.id ?? "account"}`);
}

function waitForOAuthCallback(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          res.writeHead(400);
          res.end("Missing code/state");
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400);
          res.end("Invalid OAuth state");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("InfiniteContext login complete. You can close this tab.");
        server.close();
        resolve({ code, state });
      } catch (error) {
        server.close();
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1");
    server.on("error", reject);
  });
}

function deviceId() {
  return crypto.createHash("sha256").update(`${deviceName()}:${process.env.USER ?? "user"}`).digest("hex").slice(0, 24);
}

function deviceName() {
  return `${process.env.USER ?? "user"}@${os.hostname()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLogin(argv = process.argv.slice(3)) {
  const args = parseArgs(argv);
  const baseUrl = String(args.baseUrl).replace(/\/+$/, "");

  if (args.google && args.localhost) {
    await loginWithGoogleLocalhost(baseUrl);
    return;
  }
  if (args.google) {
    await loginWithGoogleDevice(baseUrl);
    return;
  }
  await loginWithPassword({ baseUrl, email: args.email, password: args.password });
}

export async function runLogout() {
  const { loadCredentials, clearCredentials } = await import("./credentials.mjs");
  const credentials = loadCredentials();
  if (credentials?.refreshToken && credentials?.baseUrl) {
    try {
      await fetch(`${String(credentials.baseUrl).replace(/\/+$/, "")}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: credentials.refreshToken }),
      });
    } catch {
      // ignore network errors during logout
    }
  }
  clearCredentials();
  console.log("Signed out.");
}

export async function runWhoami() {
  const { getValidAccessToken } = await import("./credentials.mjs");
  const session = await getValidAccessToken({ baseUrl: process.env.INFINITECONTEXT_BASE_URL });
  if (!session?.accessToken) {
    console.log("Not signed in.");
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${session.baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) {
    console.log("Session expired or invalid. Run `infinitecontext login`.");
    process.exitCode = 1;
    return;
  }
  const body = await res.json();
  console.log(`${body.email} (${body.id})`);
}
