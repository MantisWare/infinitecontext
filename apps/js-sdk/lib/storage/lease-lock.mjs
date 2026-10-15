import crypto from "node:crypto";

import { canonicalDevH, lockRelativePath } from "./layout.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "./encrypt-storage-object.mjs";
import { decryptVaultStorageObjectPlaintext } from "./storage-object-move.mjs";

export const LEASE_LOCK_TTL_MS = 60_000;
export const LEASE_CLOCK_SKEW_MARGIN_MS = 30_000;
export const LEASE_DEFAULT_SETTLE_MS = 3_000;
const LEASE_PLAIN_FIELD = "ic_layout_lease_lock_v1";

/**
 * @typedef {Object} LeaseLockPayload
 * @property {string} owner_dev_h
 * @property {string} nonce
 * @property {number} expires_at_ms
 */

/**
 * @param {number} [nowMs]
 */
export function leaseExpiresAtMs(nowMs = Date.now()) {
  return nowMs + LEASE_LOCK_TTL_MS;
}

/** @param {LeaseLockPayload} payload @param {number} [nowMs] */
export function isLeaseLockStale(payload, nowMs = Date.now()) {
  return Number(payload.expires_at_ms ?? 0) + LEASE_CLOCK_SKEW_MARGIN_MS < nowMs;
}

/** @param {LeaseLockPayload} payload @param {string} ownerDevH @param {number} [nowMs] */
export function isLeaseLockHeldBy(payload, ownerDevH, nowMs = Date.now()) {
  if (!payload || isLeaseLockStale(payload, nowMs)) return false;
  return canonicalDevH(payload.owner_dev_h) === canonicalDevH(ownerDevH);
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 * @param {string} lockName
 */
async function readLeasePayload(adapter, dek, layoutPrefix, lockName) {
  const key = lockRelativePath(layoutPrefix, lockName);
  const row = await adapter.get(key);
  if (!row?.body) return null;
  const plain = decryptVaultStorageObjectPlaintext(dek, key, row.body);
  const payload = plain[LEASE_PLAIN_FIELD];
  if (!payload || typeof payload !== "object") return null;
  return /** @type {LeaseLockPayload} */ (payload);
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 * @param {string} lockName
 * @param {LeaseLockPayload} payload
 */
async function writeLeasePayload(adapter, dek, layoutPrefix, lockName, payload) {
  const key = lockRelativePath(layoutPrefix, lockName);
  const sealed = encryptVaultPlaintextForStoragePut(dek, key, {
    [LEASE_PLAIN_FIELD]: payload,
  });
  await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
}

/**
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 * @param {string} lockName
 * @param {LeaseLockPayload} payload
 * @param {string | undefined} ifMatch
 */
async function replaceLeasePayload(adapter, dek, layoutPrefix, lockName, payload, ifMatch) {
  const key = lockRelativePath(layoutPrefix, lockName);
  const sealed = encryptVaultPlaintextForStoragePut(dek, key, {
    [LEASE_PLAIN_FIELD]: payload,
  });
  await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifMatch });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Object} options
 * @param {import('./types.mjs').StorageAdapter} options.adapter
 * @param {Uint8Array} options.dek
 * @param {string} options.layoutPrefix
 * @param {string} options.lockName
 * @param {string} options.ownerDevH canonical
 * @param {number} [options.settleMs]
 * @param {AbortSignal} [options.signal]
 */
function jitterMs(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

async function acquireLeaseLockOnce(options) {
  const ownerDevH = canonicalDevH(options.ownerDevH);
  const lockName = String(options.lockName ?? "").trim();
  const settleMs = options.settleMs ?? LEASE_DEFAULT_SETTLE_MS;
  const key = lockRelativePath(options.layoutPrefix, lockName);
  const nonce = crypto.randomBytes(16).toString("hex");
  const now = Date.now();

  const existing = await readLeasePayload(options.adapter, options.dek, options.layoutPrefix, lockName);
  if (existing && !isLeaseLockStale(existing, now) && !isLeaseLockHeldBy(existing, ownerDevH, now)) {
    throw new Error(`Lease lock ${lockName} is held by ${existing.owner_dev_h}`);
  }
  if (existing && (isLeaseLockStale(existing, now) || isLeaseLockHeldBy(existing, ownerDevH, now))) {
    try {
      await options.adapter.delete(key);
    } catch {
      /* best-effort break */
    }
  }

  /** @type {LeaseLockPayload} */
  const payload = {
    owner_dev_h: ownerDevH,
    nonce,
    expires_at_ms: leaseExpiresAtMs(now),
  };

  try {
    await writeLeasePayload(options.adapter, options.dek, options.layoutPrefix, lockName, payload);
  } catch {
    await replaceLeasePayload(
      options.adapter,
      options.dek,
      options.layoutPrefix,
      lockName,
      payload,
      undefined,
    );
  }

  if (settleMs > 0) await sleep(settleMs);

  const readBack = await readLeasePayload(options.adapter, options.dek, options.layoutPrefix, lockName);
  if (
    !readBack ||
    canonicalDevH(readBack.owner_dev_h) !== ownerDevH ||
    String(readBack.nonce) !== nonce
  ) {
    throw new Error(`Lease lock ${lockName} read-back verification failed`);
  }

  return { nonce, expiresAtMs: payload.expires_at_ms, lockKey: key };
}

export async function acquireLeaseLock(options) {
  const maxAttempts = options.maxAttempts ?? 12;
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await acquireLeaseLockOnce(options);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/held by/i.test(message)) throw err;
      if (!/read-back verification failed/i.test(message) || attempt === maxAttempts - 1) throw err;
      await sleep(15 + jitterMs(45));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * @param {Object} options
 * @param {import('./types.mjs').StorageAdapter} options.adapter
 * @param {Uint8Array} options.dek
 * @param {string} options.layoutPrefix
 * @param {string} options.lockName
 * @param {string} options.ownerDevH
 * @param {string} options.nonce
 */
export async function renewLeaseLock(options) {
  const ownerDevH = canonicalDevH(options.ownerDevH);
  const existing = await readLeasePayload(options.adapter, options.dek, options.layoutPrefix, options.lockName);
  if (!existing || !isLeaseLockHeldBy(existing, ownerDevH) || String(existing.nonce) !== String(options.nonce)) {
    throw new Error("Cannot renew lease lock: not held");
  }
  const key = lockRelativePath(options.layoutPrefix, options.lockName);
  const head = await options.adapter.head(key);
  /** @type {LeaseLockPayload} */
  const payload = {
    owner_dev_h: ownerDevH,
    nonce: String(options.nonce),
    expires_at_ms: leaseExpiresAtMs(),
  };
  await replaceLeasePayload(
    options.adapter,
    options.dek,
    options.layoutPrefix,
    options.lockName,
    payload,
    head?.etag,
  );
}

/**
 * @param {Object} options
 * @param {import('./types.mjs').StorageAdapter} options.adapter
 * @param {Uint8Array} options.dek
 * @param {string} options.layoutPrefix
 * @param {string} options.lockName
 * @param {string} options.ownerDevH
 * @param {string} options.nonce
 */
export async function releaseLeaseLock(options) {
  const ownerDevH = canonicalDevH(options.ownerDevH);
  const existing = await readLeasePayload(options.adapter, options.dek, options.layoutPrefix, options.lockName);
  if (!existing || canonicalDevH(existing.owner_dev_h) !== ownerDevH || String(existing.nonce) !== String(options.nonce)) {
    return;
  }
  const key = lockRelativePath(options.layoutPrefix, options.lockName);
  await options.adapter.delete(key);
}

/**
 * Run `fn` while holding a lease lock (advisory).
 * @template T
 * @param {Object} options
 * @param {import('./types.mjs').StorageAdapter} options.adapter
 * @param {Uint8Array} options.dek
 * @param {string} options.layoutPrefix
 * @param {string} options.lockName
 * @param {string} options.ownerDevH
 * @param {number} [options.settleMs]
 * @param {() => Promise<T>} options.fn
 */
export async function withLeaseLock(options) {
  const handle = await acquireLeaseLock(options);
  try {
    return await options.fn();
  } finally {
    await releaseLeaseLock({
      adapter: options.adapter,
      dek: options.dek,
      layoutPrefix: options.layoutPrefix,
      lockName: options.lockName,
      ownerDevH: options.ownerDevH,
      nonce: handle.nonce,
    });
  }
}
