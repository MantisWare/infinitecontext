import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { infinitecontextHome } from "./credentials.mjs";

const SOCKET_NAME = "vault-agent.sock";
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/** @type {Map<string, { dek: Buffer, expiresAt: number }>} */
const unlocked = new Map();

let server = null;
let idleTimer = null;

function socketPath() {
  return path.join(infinitecontextHome(), SOCKET_NAME);
}

function scheduleIdleShutdown(idleMs) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    unlocked.clear();
    try {
      server?.close();
    } catch {
      // ignore
    }
    server = null;
    try {
      fs.unlinkSync(socketPath());
    } catch {
      // ignore
    }
  }, idleMs);
}

function writeResponse(socket, payload) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function handleConnection(socket) {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        writeResponse(socket, { ok: false, error: "invalid_json" });
        continue;
      }
      const { cmd, accountKey, dekB64, ttlMs } = msg ?? {};
      if (cmd === "ping") {
        writeResponse(socket, { ok: true, pong: true });
        continue;
      }
      if (cmd === "store" && accountKey && dekB64) {
        const ttl = Number(ttlMs ?? DEFAULT_IDLE_MS);
        unlocked.set(String(accountKey), {
          dek: Buffer.from(String(dekB64), "base64"),
          expiresAt: Date.now() + ttl,
        });
        scheduleIdleShutdown(ttl);
        writeResponse(socket, { ok: true });
        continue;
      }
      if (cmd === "get" && accountKey) {
        const row = unlocked.get(String(accountKey));
        if (!row || row.expiresAt <= Date.now()) {
          writeResponse(socket, { ok: true, dekB64: null });
          continue;
        }
        writeResponse(socket, { ok: true, dekB64: row.dek.toString("base64"), expiresAt: row.expiresAt });
        continue;
      }
      if (cmd === "clear" && accountKey) {
        unlocked.delete(String(accountKey));
        writeResponse(socket, { ok: true });
        continue;
      }
      writeResponse(socket, { ok: false, error: "unknown_command" });
    }
  });
}

async function ensureAgentServer({ idleMs = DEFAULT_IDLE_MS } = {}) {
  if (server) return;
  const dir = infinitecontextHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = socketPath();
  try {
    fs.unlinkSync(sock);
  } catch {
    // ignore
  }
  await new Promise((resolve, reject) => {
    server = net.createServer(handleConnection);
    server.on("error", reject);
    server.listen(sock, () => {
      try {
        fs.chmodSync(sock, 0o600);
      } catch {
        // ignore
      }
      resolve(undefined);
    });
  });
  scheduleIdleShutdown(idleMs);
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

export async function vaultAgentStore(accountKey, dekBytes, { ttlMs = DEFAULT_IDLE_MS } = {}) {
  await ensureAgentServer({ idleMs: ttlMs });
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
