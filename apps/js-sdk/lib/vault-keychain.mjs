import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { infinitecontextHome } from "./credentials.mjs";

const CACHE_FILE = "vault-cache.json";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

let memoryDek = null;
let memoryExpiresAt = 0;

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

function cacheFilePath() {
  return path.join(infinitecontextHome(), CACHE_FILE);
}

function readFileCache(accountKey) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"));
    if (raw?.accountKey !== accountKey) return null;
    if (Date.parse(String(raw.expiresAt ?? 0)) <= Date.now()) return null;
    const dekB64 = String(raw.dekB64 ?? "");
    if (!dekB64) return null;
    return Buffer.from(dekB64, "base64");
  } catch {
    return null;
  }
}

function writeFileCache(accountKey, dekBytes, ttlMs) {
  const dir = infinitecontextHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  fs.writeFileSync(
    cacheFilePath(),
    `${JSON.stringify({ accountKey, dekB64: Buffer.from(dekBytes).toString("base64"), expiresAt }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function clearVaultKeychainCache(accountKey) {
  memoryDek = null;
  memoryExpiresAt = 0;
  try {
    fs.unlinkSync(cacheFilePath());
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
    return;
  }
  writeFileCache(accountKey, dekBytes, ttlMs);
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

  const fromFile = readFileCache(accountKey);
  if (!fromFile) return null;
  memoryDek = fromFile;
  return new Uint8Array(fromFile);
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
