import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { xchacha20poly1305 } from "@noble/ciphers/chacha";

import { infinitecontextHome } from "./credentials.mjs";

const ENCRYPTED_CACHE_FILE = "vault-cache.enc";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** @type {Buffer | null} */
let memoryDek = null;
let memoryExpiresAt = 0;

/** In-process session secret for optional encrypted cache (never written to disk). */
let sessionWrapKey = null;
let sessionWrapExpiresAt = 0;

/** @returns {Promise<import('keytar') | null>} */
async function loadKeytar() {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)");
    const mod = await dynamicImport("keytar");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function encryptedCachePath() {
  return path.join(infinitecontextHome(), ENCRYPTED_CACHE_FILE);
}

function ensureSessionWrapKey(ttlMs) {
  if (sessionWrapKey && sessionWrapExpiresAt > Date.now()) return sessionWrapKey;
  sessionWrapKey = crypto.randomBytes(32);
  sessionWrapExpiresAt = Date.now() + ttlMs;
  return sessionWrapKey;
}

function writeEncryptedCache(accountKey, dekBytes, ttlMs) {
  const wrapKey = ensureSessionWrapKey(ttlMs);
  const nonce = crypto.randomBytes(24);
  const aad = new TextEncoder().encode(`infinitecontext/vault-cache/v1|${accountKey}`);
  const cipher = xchacha20poly1305(wrapKey, nonce, aad);
  const ct = cipher.encrypt(dekBytes);
  const payload = {
    v: 1,
    accountKey,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    nonce: Buffer.from(nonce).toString("base64"),
    ct: Buffer.from(ct).toString("base64"),
  };
  const dir = infinitecontextHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(encryptedCachePath(), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

function readEncryptedCache(accountKey) {
  if (!sessionWrapKey || sessionWrapExpiresAt <= Date.now()) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(encryptedCachePath(), "utf8"));
    if (raw?.accountKey !== accountKey) return null;
    if (Date.parse(String(raw.expiresAt ?? 0)) <= Date.now()) return null;
    const nonce = Buffer.from(String(raw.nonce ?? ""), "base64");
    const ct = Buffer.from(String(raw.ct ?? ""), "base64");
    const aad = new TextEncoder().encode(`infinitecontext/vault-cache/v1|${accountKey}`);
    const cipher = xchacha20poly1305(sessionWrapKey, nonce, aad);
    return cipher.decrypt(ct);
  } catch {
    return null;
  }
}

function removeLegacyPlaintextCache() {
  try {
    fs.unlinkSync(path.join(infinitecontextHome(), "vault-cache.json"));
  } catch {
    // ignore
  }
}

export function clearVaultKeychainCache(accountKey) {
  memoryDek = null;
  memoryExpiresAt = 0;
  sessionWrapKey = null;
  sessionWrapExpiresAt = 0;
  removeLegacyPlaintextCache();
  try {
    fs.unlinkSync(encryptedCachePath());
  } catch {
    // ignore
  }
  void (async () => {
    const keytar = await loadKeytar();
    if (!keytar) return;
    try {
      await keytar.deletePassword("infinitecontext-vault", accountKey);
    } catch {
      // ignore
    }
  })();
}

export async function storeUnlockedDek(accountKey, dekBytes, { ttlMs = DEFAULT_TTL_MS } = {}) {
  memoryDek = Buffer.from(dekBytes);
  memoryExpiresAt = Date.now() + ttlMs;

  const keytar = await loadKeytar();
  if (keytar) {
    const payload = JSON.stringify({
      dekB64: Buffer.from(dekBytes).toString("base64"),
      expiresAt: new Date(memoryExpiresAt).toISOString(),
    });
    await keytar.setPassword("infinitecontext-vault", accountKey, payload);
    removeLegacyPlaintextCache();
    try {
      fs.unlinkSync(encryptedCachePath());
    } catch {
      // ignore
    }
    return;
  }

  writeEncryptedCache(accountKey, dekBytes, ttlMs);
}

export async function loadCachedDek(accountKey) {
  if (memoryDek && memoryExpiresAt > Date.now()) {
    return new Uint8Array(memoryDek);
  }

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const payload = await keytar.getPassword("infinitecontext-vault", accountKey);
      if (!payload) return null;
      const parsed = JSON.parse(payload);
      if (Date.parse(String(parsed.expiresAt ?? 0)) <= Date.now()) return null;
      const dek = Buffer.from(String(parsed.dekB64 ?? ""), "base64");
      memoryDek = dek;
      memoryExpiresAt = Date.parse(String(parsed.expiresAt));
      return new Uint8Array(dek);
    } catch {
      return null;
    }
  }

  const fromEncrypted = readEncryptedCache(accountKey);
  if (!fromEncrypted) return null;
  memoryDek = Buffer.from(fromEncrypted);
  memoryExpiresAt = Date.parse(String(JSON.parse(fs.readFileSync(encryptedCachePath(), "utf8")).expiresAt));
  return new Uint8Array(fromEncrypted);
}

export function vaultAccountKey({ userPublicId, email }) {
  const id = String(userPublicId ?? email ?? "default").trim();
  return id || "default";
}

export function defaultVaultTtlMs() {
  const fromEnv = Number(process.env.INFINITECONTEXT_VAULT_TTL_SEC ?? "");
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1000;
  return DEFAULT_TTL_MS;
}

export function deviceName() {
  return `${os.hostname()} (${os.userInfo().username})`;
}
