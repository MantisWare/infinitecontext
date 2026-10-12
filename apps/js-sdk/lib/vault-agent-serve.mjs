#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { infinitecontextHome } from "./credentials.mjs";

const SOCKET_NAME = "vault-agent.sock";
const PID_NAME = "vault-agent.pid";
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/** @type {Map<string, { dek: Buffer, expiresAt: number }>} */
const unlocked = new Map();

let idleTimer = null;

function socketPath() {
  return path.join(infinitecontextHome(), SOCKET_NAME);
}

function pidPath() {
  return path.join(infinitecontextHome(), PID_NAME);
}

function scheduleIdleShutdown(idleMs) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    unlocked.clear();
    try {
      fs.unlinkSync(socketPath());
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(pidPath());
    } catch {
      // ignore
    }
    process.exit(0);
  }, idleMs);
}

function writeResponse(socket, payload) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

const server = net.createServer((socket) => {
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
      if (cmd === "shutdown") {
        writeResponse(socket, { ok: true });
        process.exit(0);
      }
      writeResponse(socket, { ok: false, error: "unknown_command" });
    }
  });
});

const dir = infinitecontextHome();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
try {
  fs.unlinkSync(socketPath());
} catch {
  // ignore
}

server.listen(socketPath(), () => {
  try {
    fs.chmodSync(socketPath(), 0o600);
  } catch {
    // ignore
  }
  fs.writeFileSync(pidPath(), `${process.pid}\n`, { mode: 0o600 });
  scheduleIdleShutdown(DEFAULT_IDLE_MS);
});

server.on("error", (err) => {
  console.error(`vault-agent: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
