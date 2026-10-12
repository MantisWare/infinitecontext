import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { infinitecontextHome } from "./credentials.mjs";

const SOCKET_NAME = "vault-agent.sock";
const PID_NAME = "vault-agent.pid";
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

function resolveServeScript() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "vault-agent-serve.mjs"),
    path.join(here, "..", "lib", "vault-agent-serve.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("vault-agent-serve.mjs not found in package");
}

function socketPath() {
  return path.join(infinitecontextHome(), SOCKET_NAME);
}

function pidPath() {
  return path.join(infinitecontextHome(), PID_NAME);
}

function agentRequest(payload, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("vault agent timeout"));
    }, timeoutMs);
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on("connect", () => {
      sock.write(`${JSON.stringify(payload)}\n`);
    });
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      const line = buffer.slice(0, newline);
      sock.end();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("vault agent invalid response"));
      }
    });
  });
}

async function pingAgent() {
  try {
    const res = await agentRequest({ cmd: "ping" }, { timeoutMs: 500 });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

export async function ensureDetachedVaultAgent() {
  if (await pingAgent()) return;
  const child = spawn(process.execPath, [resolveServeScript()], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    if (await pingAgent()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Failed to start background vault agent");
}

export async function vaultAgentStore(accountKey, dekBytes, { ttlMs = DEFAULT_IDLE_MS } = {}) {
  await ensureDetachedVaultAgent();
  const res = await agentRequest({
    cmd: "store",
    accountKey,
    dekB64: Buffer.from(dekBytes).toString("base64"),
    ttlMs,
  });
  if (!res?.ok) throw new Error("Failed to store DEK in vault agent");
}

export async function vaultAgentLoad(accountKey) {
  try {
    const res = await agentRequest({ cmd: "get", accountKey });
    if (!res?.ok || !res.dekB64) return null;
    if (Number(res.expiresAt ?? 0) <= Date.now()) return null;
    return new Uint8Array(Buffer.from(String(res.dekB64), "base64"));
  } catch {
    return null;
  }
}

export async function vaultAgentClear(accountKey) {
  try {
    await agentRequest({ cmd: "clear", accountKey });
  } catch {
    // ignore
  }
}

export async function vaultAgentShutdown() {
  try {
    await agentRequest({ cmd: "shutdown" }, { timeoutMs: 1500 });
  } catch {
    // ignore
  }
  try {
    const pid = fs.readFileSync(pidPath(), "utf8").trim();
    if (pid) process.kill(Number(pid), "SIGTERM");
  } catch {
    // ignore
  }
}

export function vaultAgentAvailable() {
  try {
    return fs.existsSync(socketPath());
  } catch {
    return false;
  }
}

export function randomRootAadNonce() {
  return crypto.randomBytes(16).toString("hex");
}

export const VAULT_AGENT_DOC =
  "When OS keychain is unavailable, unlock starts a background vault-agent (0600 Unix socket under ~/.infinitecontext/) that holds your DEK until idle timeout or `infinitecontext vault lock`.";
