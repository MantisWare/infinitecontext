import { STORAGE_CAPABILITIES } from "./types.mjs";
import { PreconditionFailedError } from "./errors.mjs";
import {
  LEASE_DEFAULT_SETTLE_MS,
  readLeaseLockForFence,
  verifyLeaseLockAfterWrite,
  withLeaseLock,
} from "./lease-lock.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "./encrypt-storage-object.mjs";
import { decryptVaultStorageObjectPlaintext } from "./storage-object-move.mjs";

function jitterMs(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

function adapterSupportsCas(adapter) {
  return (
    adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalCreate) &&
    adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace)
  );
}

/**
 * @param {Uint8Array} dek
 * @param {string} objectKey
 * @param {unknown} plaintext
 */
export function sealLayoutObjectPlaintext(dek, objectKey, plaintext) {
  return copyVerifiedStoragePutBodyForAdapter(
    encryptVaultPlaintextForStoragePut(dek, objectKey, plaintext),
  );
}

/**
 * @param {Uint8Array} dek
 * @param {string} objectKey
 * @param {Uint8Array} body
 */
export function readLayoutObjectPlaintext(dek, objectKey, body) {
  return decryptVaultStorageObjectPlaintext(dek, objectKey, body);
}

/**
 * Read-modify-write with CAS when supported, otherwise under a lease lock.
 *
 * @template T
 * @param {Object} params
 * @param {import('./types.mjs').StorageAdapter} params.adapter
 * @param {Uint8Array} params.dek
 * @param {string} params.objectKey
 * @param {string} params.layoutPrefix
 * @param {string} params.lockName
 * @param {string} params.ownerDevH
 * @param {number} [params.maxAttempts]
 * @param {number} [params.settleMs]
 * @param {(current: unknown | null) => Promise<{ plaintext: unknown, result: T }> | { plaintext: unknown, result: T }} params.mutate
 */
export async function storageReadModifyWrite(params) {
  const maxAttempts = params.maxAttempts ?? 5;
  if (adapterSupportsCas(params.adapter)) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const row = await params.adapter.get(params.objectKey);
      const current = row?.body
        ? readLayoutObjectPlaintext(params.dek, params.objectKey, row.body)
        : null;
      const mutated = await params.mutate(current);
      const { plaintext, result } = mutated;
      if (mutated.skipWrite) return result;
      const body = sealLayoutObjectPlaintext(params.dek, params.objectKey, plaintext);
      try {
        if (!row) {
          await params.adapter.put(params.objectKey, body, { ifNoneMatch: "*" });
        } else {
          await params.adapter.put(params.objectKey, body, { ifMatch: row.etag });
        }
        return result;
      } catch (err) {
        if (!(err instanceof PreconditionFailedError) || attempt === maxAttempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 20 + jitterMs(80)));
      }
    }
    throw new Error("storageReadModifyWrite exhausted CAS attempts");
  }

  const settleMs = Math.max(params.settleMs ?? 0, LEASE_DEFAULT_SETTLE_MS);
  return withLeaseLock({
    adapter: params.adapter,
    dek: params.dek,
    layoutPrefix: params.layoutPrefix,
    lockName: params.lockName,
    ownerDevH: params.ownerDevH,
    settleMs,
    fn: async (lease) => {
      const row = await params.adapter.get(params.objectKey);
      const current = row?.body
        ? readLayoutObjectPlaintext(params.dek, params.objectKey, row.body)
        : null;
      const mutated = await params.mutate(current);
      const { plaintext, result } = mutated;
      if (mutated.skipWrite) return result;
      await readLeaseLockForFence({
        adapter: params.adapter,
        dek: params.dek,
        layoutPrefix: params.layoutPrefix,
        lockName: params.lockName,
        ownerDevH: params.ownerDevH,
        nonce: lease.nonce,
      });
      const body = sealLayoutObjectPlaintext(params.dek, params.objectKey, plaintext);
      if (!row) {
        await params.adapter.put(params.objectKey, body, { ifNoneMatch: "*" });
      } else if (adapterSupportsCas(params.adapter)) {
        await params.adapter.put(params.objectKey, body, { ifMatch: row.etag });
      } else {
        await params.adapter.put(params.objectKey, body);
      }
      await verifyLeaseLockAfterWrite({
        adapter: params.adapter,
        dek: params.dek,
        layoutPrefix: params.layoutPrefix,
        lockName: params.lockName,
        ownerDevH: params.ownerDevH,
        nonce: lease.nonce,
      });
      return result;
    },
  });
}

/**
 * Create-only CAS put (snapshots).
 * @param {Object} params
 * @param {import('./types.mjs').StorageAdapter} params.adapter
 * @param {Uint8Array} params.dek
 * @param {string} params.objectKey
 * @param {unknown} params.plaintext
 */
export async function storageConditionalCreate(params) {
  const body = sealLayoutObjectPlaintext(params.dek, params.objectKey, params.plaintext);
  await params.adapter.put(params.objectKey, body, { ifNoneMatch: "*" });
}
