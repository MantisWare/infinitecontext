import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
} from "../../lib/storage/lease-lock.mjs";
import { deriveDevH, lockRelativePath } from "../../lib/storage/layout.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";

export const RACE_TEST_DEK = new Uint8Array(32).fill(9);
export const RACE_DEV_A = deriveDevH(RACE_TEST_DEK, "11111111-1111-4111-8111-111111111111");
export const RACE_DEV_B = deriveDevH(RACE_TEST_DEK, "22222222-2222-4222-8222-222222222222");
export const RACE_LAYOUT_PREFIX = "acct/lease-owner";
export const RACE_LOCK_NAME = "shared.manifest";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pause the first get on the lock key until the second get releases the gate (B can finish acquire).
 * @param {import("../../lib/storage/types.mjs").StorageAdapter} inner
 * @param {string} lockKey
 */
export function wrapAdapterWithFirstGetBarrier(inner, lockKey) {
  let firstGetDone = false;
  /** @type {() => void} */
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  return {
    ...inner,
    async init() {
      await inner.init();
    },
    async close() {
      await inner.close();
    },
    async get(key, opts) {
      const row = await inner.get(key, opts);
      if (key === lockKey && !firstGetDone) {
        firstGetDone = true;
        await gate;
      }
      return row;
    },
    async put(key, body, opts) {
      const out = await inner.put(key, body, opts);
      if (key === lockKey && opts?.ifNoneMatch === "*") {
        releaseGate();
      }
      return out;
    },
    async delete(key, opts) {
      return inner.delete(key, opts);
    },
    async head(key, opts) {
      return inner.head(key, opts);
    },
  };
}

/**
 * @param {import("../../lib/storage/types.mjs").StorageAdapter} adapter
 * @param {string} layoutPrefix
 * @param {string} lockName
 * @param {Uint8Array} dek
 * @param {string} staleOwnerDevH
 */
export async function seedStaleLock(adapter, layoutPrefix, lockName, dek, staleOwnerDevH) {
  const key = lockRelativePath(layoutPrefix, lockName);
  const stalePayload = {
    owner_dev_h: staleOwnerDevH,
    nonce: "stale-seed",
    expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
  };
  const sealed = encryptVaultPlaintextForStoragePut(dek, key, {
    ic_layout_lease_lock_v1: stalePayload,
  });
  await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
}

/**
 * Concurrent stale-break race with first-get barrier (detects 77db470 double-get revert).
 * @returns {Promise<{ winners: PromiseFulfilledResult<{ nonce: string }>[], adapter: import("../../lib/storage/types.mjs").StorageAdapter }>}
 */
export async function runFirstGetBarrierStaleBreakRace() {
  const lockKey = lockRelativePath(RACE_LAYOUT_PREFIX, RACE_LOCK_NAME);
  const inner = createMemoryStorageAdapter();
  await inner.init();
  await seedStaleLock(inner, RACE_LAYOUT_PREFIX, RACE_LOCK_NAME, RACE_TEST_DEK, RACE_DEV_A);
  const adapter = wrapAdapterWithFirstGetBarrier(inner, lockKey);

  const aPromise = acquireLeaseLock({
    adapter,
    dek: RACE_TEST_DEK,
    layoutPrefix: RACE_LAYOUT_PREFIX,
    lockName: RACE_LOCK_NAME,
    ownerDevH: RACE_DEV_A,
    settleMs: 0,
  });
  const bPromise = acquireLeaseLock({
    adapter,
    dek: RACE_TEST_DEK,
    layoutPrefix: RACE_LAYOUT_PREFIX,
    lockName: RACE_LOCK_NAME,
    ownerDevH: RACE_DEV_B,
    settleMs: 0,
  });
  aPromise.catch(() => {});
  bPromise.catch(() => {});
  await sleep(5);
  const results = await Promise.allSettled([aPromise, bPromise]);
  const winners = results.filter((r) => r.status === "fulfilled");
  return { winners, adapter: inner };
}

/**
 * @param {number} runs
 * @returns {Promise<number>} count of runs with two successful acquires
 */
export async function countDoubleHoldRuns(runs) {
  let doubleHolds = 0;
  for (let i = 0; i < runs; i += 1) {
    const { winners, adapter } = await runFirstGetBarrierStaleBreakRace();
    if (winners.length >= 2) {
      doubleHolds += 1;
    }
    await adapter.close();
  }
  return doubleHolds;
}
