import os from "node:os";

import { getVaultKeychainBackendForTests } from "./vault-keychain-inject.mjs";
import { vaultAgentClear, vaultAgentLoad, vaultAgentStore } from "./vault-agent.mjs";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const KEYTAR_IO_TIMEOUT_MS = 2_000;

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 */
async function withKeytarTimeout(promise, timeoutMs = KEYTAR_IO_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("keytar timeout")), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @type {Buffer | null} */
let memoryDek = null;
let memoryExpiresAt = 0;

/** @returns {Promise<import('./vault-keychain-inject.mjs').VaultKeychainBackend | import('keytar') | null>} */
async function loadKeytar() {
  const injected = getVaultKeychainBackendForTests();
  if (injected) return injected;
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)");
    const mod = await dynamicImport("keytar");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function clearVaultKeychainCache(accountKey) {
  memoryDek = null;
  memoryExpiresAt = 0;
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword("infinitecontext-vault", accountKey);
    } catch {
      // ignore
    }
  }
  await vaultAgentClear(accountKey);
}

/**
 * @param {string} accountKey
 * @param {Uint8Array} dekBytes
 * @param {{ ttlMs?: number }} [options]
 */
export async function storeUnlockedDek(accountKey, dekBytes, { ttlMs = DEFAULT_TTL_MS } = {}) {
  memoryDek = Buffer.from(dekBytes);
  memoryExpiresAt = Date.now() + ttlMs;

  const keytar = await loadKeytar();
  if (keytar) {
    const payload = JSON.stringify({
      dekB64: Buffer.from(dekBytes).toString("base64"),
      expiresAt: new Date(memoryExpiresAt).toISOString(),
    });
    const stored = await withKeytarTimeout(
      keytar.setPassword("infinitecontext-vault", accountKey, payload),
    );
    if (stored !== null) {
      return;
    }
  }

  await vaultAgentStore(accountKey, dekBytes, { ttlMs });
}

/**
 * Verify unlock can be reloaded without this process memory cache (keychain or vault agent).
 *
 * @param {string} accountKey
 */
export async function assertVaultUnlockPersisted(accountKey) {
  const savedDek = memoryDek;
  const savedExpires = memoryExpiresAt;
  memoryDek = null;
  memoryExpiresAt = 0;
  try {
    const loaded = await loadCachedDek(accountKey);
    if (!loaded) {
      throw new Error(
        "Vault unlock did not persist (OS keychain and vault agent unavailable). Unlock will not survive leaving this process.",
      );
    }
    memoryDek = Buffer.from(loaded);
    memoryExpiresAt = savedExpires > Date.now() ? savedExpires : Date.now() + DEFAULT_TTL_MS;
  } catch (error) {
    memoryDek = savedDek;
    memoryExpiresAt = savedExpires;
    throw error;
  }
}

export async function loadCachedDek(accountKey) {
  if (memoryDek && memoryExpiresAt > Date.now()) {
    return new Uint8Array(memoryDek);
  }

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const payload = await withKeytarTimeout(
        keytar.getPassword("infinitecontext-vault", accountKey),
      );
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

  const fromAgent = await vaultAgentLoad(accountKey);
  if (!fromAgent) {
    throw new Error(
      "Vault is locked and no OS keychain is available. Run `infinitecontext vault unlock` in a session where the vault agent can start (or install keytar for your platform).",
    );
  }
  memoryDek = Buffer.from(fromAgent);
  memoryExpiresAt = Date.now() + DEFAULT_TTL_MS;
  return fromAgent;
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
