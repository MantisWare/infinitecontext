import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
  readLeaseLockForFence,
} from "../../lib/storage/lease-lock.mjs";
import { deriveDevH, lockRelativePath } from "../../lib/storage/layout.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";

const TEST_DEK = new Uint8Array(32).fill(9);
const DEV_A = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
const DEV_B = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
const LAYOUT_PREFIX = "acct/lease-owner";
const LOCK_NAME = "shared.manifest";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import("../../lib/storage/types.mjs").StorageAdapter} inner
 * @param {string | null} headEtagOverride
 */
function wrapHeadEtagDrift(inner, headEtagOverride) {
  return {
    ...inner,
    async head(key, options) {
      const row = await inner.head(key, options);
      if (!row || headEtagOverride === null) {
        return row;
      }
      return { ...row, etag: headEtagOverride };
    },
  };
}

/**
 * Real storage adapter with a barrier before conditional delete (stale-break path).
 * @param {import("../../lib/storage/types.mjs').StorageAdapter} inner
 * @param {() => void | Promise<void>} awaitBarrier
 */
function wrapAdapterWithDeleteBarrier(inner, awaitBarrier) {
  return {
    ...inner,
    async init() {
      await inner.init();
    },
    async close() {
      await inner.close();
    },
    async get(key, opts) {
      return inner.get(key, opts);
    },
    async put(key, body, opts) {
      return inner.put(key, body, opts);
    },
    async delete(key, opts) {
      await awaitBarrier();
      return inner.delete(key, opts);
    },
    async head(key, opts) {
      return inner.head(key, opts);
    },
  };
}

async function seedStaleLock(adapter, lockName) {
  const key = lockRelativePath(LAYOUT_PREFIX, lockName);
  const stalePayload = {
    owner_dev_h: DEV_A,
    nonce: "stale-seed",
    expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
  };
  const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
    ic_layout_lease_lock_v1: stalePayload,
  });
  await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
}

async function runForcedStaleBreakRace(lockName) {
  /** @type {() => void} */
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  const inner = createMemoryStorageAdapter();
  await inner.init();
  await seedStaleLock(inner, lockName);
  const adapter = wrapAdapterWithDeleteBarrier(inner, async () => {
    waiting += 1;
    if (waiting >= 2) {
      release();
    }
    await paused;
  });

  const aPromise = acquireLeaseLock({
    adapter,
    dek: TEST_DEK,
    layoutPrefix: LAYOUT_PREFIX,
    lockName,
    ownerDevH: DEV_A,
    settleMs: 0,
  });
  const bPromise = acquireLeaseLock({
    adapter,
    dek: TEST_DEK,
    layoutPrefix: LAYOUT_PREFIX,
    lockName,
    ownerDevH: DEV_B,
    settleMs: 0,
  });
  aPromise.catch(() => {});
  bPromise.catch(() => {});
  await sleep(30);
  if (waiting < 2) {
    release();
  }
  const results = await Promise.allSettled([aPromise, bPromise]);
  return { winners: results.filter((r) => r.status === "fulfilled"), adapter: inner };
}

describe("lease lock owner etag races (QA #4)", () => {
  it("stale-break delete uses etag from the first get (head drift rejects wrong etag)", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const key = lockRelativePath(LAYOUT_PREFIX, "drift");
    const payload = {
      owner_dev_h: DEV_A,
      nonce: "stale-nonce",
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
    };
    const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
      ic_layout_lease_lock_v1: payload,
    });
    await inner.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });
    const live = await inner.get(key);
    assert.ok(live?.etag);

    const drift = wrapHeadEtagDrift(inner, '"stale-head-etag"');
    await assert.rejects(
      () => drift.delete(key, { ifMatch: '"stale-head-etag"' }),
      (err) => err instanceof PreconditionFailedError,
    );
    assert.ok(await inner.get(key));
    await inner.delete(key, { ifMatch: live.etag });
    await inner.close();
  });

  it("forced stale-break race (settle 0): real acquireLeaseLock allows only one holder", async () => {
    const { winners, adapter } = await runForcedStaleBreakRace(LOCK_NAME);
    assert.equal(
      winners.length,
      1,
      "fixed single-get stale-break must not double-win under a forced delete barrier",
    );
    await adapter.close();
  });

  it("barrier stale-break with settle 0: only one holder after forced race window", async () => {
    const { winners, adapter } = await runForcedStaleBreakRace(LOCK_NAME);
    assert.equal(winners.length, 1, "forced race must produce exactly one successful acquire");

    const winner = /** @type {PromiseFulfilledResult<{ nonce: string }>} */ (winners[0]).value;
    await readLeaseLockForFence({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: LOCK_NAME,
      ownerDevH: DEV_A,
      nonce: winner.nonce,
    });
    await adapter.close();
  });
});
