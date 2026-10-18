import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
  leaseExpiresAtMs,
  readLeaseLockForFence,
  resetLeaseLockLegacySecondGetStaleBreakForTests,
  resetLeaseLockStaleBreakBarrierForTests,
  setLeaseLockLegacySecondGetStaleBreakForTests,
  setLeaseLockStaleBreakBarrierForTests,
} from "../../lib/storage/lease-lock.mjs";
import { canonicalDevH, deriveDevH, lockRelativePath } from "../../lib/storage/layout.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import { decryptVaultStorageObjectPlaintext } from "../../lib/storage/storage-object-move.mjs";

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

const legacyAcquireOwner = new AsyncLocalStorage();

/**
 * Adapter that returns a duplicate etag on the second get() during legacy stale-break (77db470).
 */
function createLegacySecondGetDoubleWinAdapter(dek, layoutPrefix, lockName) {
  /** @type {Map<string, { body: Uint8Array, etag: string }>} */
  const store = new Map();
  /** @type {Map<string, string>} */
  const readBackNonceByOwner = new Map();
  const etag = () => `"${crypto.randomBytes(8).toString("hex")}"`;
  const key = lockRelativePath(layoutPrefix, lockName);

  return {
    async init() {},
    async close() {},
    async get(storageKey) {
      const entry = store.get(storageKey);
      const owner = legacyAcquireOwner.getStore();
      if (owner && readBackNonceByOwner.has(owner) && storageKey === key) {
        const nonce = readBackNonceByOwner.get(owner);
        const payload = {
          owner_dev_h: owner,
          nonce,
          expires_at_ms: leaseExpiresAtMs(),
        };
        const sealed = encryptVaultPlaintextForStoragePut(dek, key, {
          ic_layout_lease_lock_v1: payload,
        });
        return {
          body: copyVerifiedStoragePutBodyForAdapter(sealed),
          etag: entry?.etag ?? etag(),
        };
      }
      if (!entry) return null;
      if (globalThis.__icLeaseLegacySecondGet) {
        return { body: entry.body, etag: `${entry.etag}-second-get` };
      }
      return { body: entry.body, etag: entry.etag };
    },
    async delete(storageKey, { ifMatch } = {}) {
      const entry = store.get(storageKey);
      if (!entry) return;
      const live = entry.etag;
      const matches =
        ifMatch === undefined || ifMatch === live || ifMatch === `${live}-second-get`;
      if (!matches) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      store.delete(storageKey);
    },
    async put(storageKey, body, { ifNoneMatch, ifMatch } = {}) {
      const cur = store.get(storageKey);
      if (ifNoneMatch === "*" && cur) {
        throw new PreconditionFailedError("Object already exists");
      }
      if (ifMatch && (!cur || cur.etag !== ifMatch)) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      store.set(storageKey, { body, etag: etag() });
    },
    noteSuccessfulAcquire(ownerDevH, nonce) {
      readBackNonceByOwner.set(canonicalDevH(ownerDevH), nonce);
    },
  };
}

function acquireLeaseLockWithOwnerContext(options) {
  return legacyAcquireOwner.run(canonicalDevH(options.ownerDevH), () => acquireLeaseLock(options));
}

describe("lease lock owner etag races (QA #4)", () => {
  afterEach(() => {
    resetLeaseLockStaleBreakBarrierForTests();
    resetLeaseLockLegacySecondGetStaleBreakForTests();
  });

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

  it("77db470 second-get stale-break: forced window allows double-win (fixed code must not)", async () => {
    const lockName = "legacy-double";
    const legacyAdapter = createLegacySecondGetDoubleWinAdapter(TEST_DEK, LAYOUT_PREFIX, lockName);
    const key = lockRelativePath(LAYOUT_PREFIX, lockName);
    const stalePayload = {
      owner_dev_h: DEV_A,
      nonce: "legacy-stale",
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
    };
    const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
      ic_layout_lease_lock_v1: stalePayload,
    });
    await legacyAdapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });

    /** @type {() => void} */
    let releaseLegacyBarrier;
    const legacyPaused = new Promise((resolve) => {
      releaseLegacyBarrier = resolve;
    });
    setLeaseLockLegacySecondGetStaleBreakForTests(true);
    setLeaseLockStaleBreakBarrierForTests(() => legacyPaused);

    const legacyA = acquireLeaseLockWithOwnerContext({
      adapter: legacyAdapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName,
      ownerDevH: DEV_A,
      settleMs: 0,
    });
    const legacyB = acquireLeaseLockWithOwnerContext({
      adapter: legacyAdapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName,
      ownerDevH: DEV_B,
      settleMs: 0,
    });
    await sleep(20);
    releaseLegacyBarrier();
    const legacyResults = await Promise.allSettled([legacyA, legacyB]);
    resetLeaseLockLegacySecondGetStaleBreakForTests();
    resetLeaseLockStaleBreakBarrierForTests();
    const legacyWinners = legacyResults.filter((r) => r.status === "fulfilled");
    assert.equal(
      legacyWinners.length,
      2,
      "77db470 second-get stale-break must double-win under a forced window (settleMs 0)",
    );

    const fixedAdapter = createMemoryStorageAdapter();
    await fixedAdapter.init();
    await fixedAdapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });

    /** @type {() => void} */
    let releaseFixedBarrier;
    const fixedPaused = new Promise((resolve) => {
      releaseFixedBarrier = resolve;
    });
    setLeaseLockStaleBreakBarrierForTests(() => fixedPaused);
    const fixedA = acquireLeaseLock({
      adapter: fixedAdapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName,
      ownerDevH: DEV_A,
      settleMs: 0,
    });
    const fixedB = acquireLeaseLock({
      adapter: fixedAdapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName,
      ownerDevH: DEV_B,
      settleMs: 0,
    });
    await sleep(20);
    releaseFixedBarrier();
    const fixedResults = await Promise.allSettled([fixedA, fixedB]);
    const fixedWinners = fixedResults.filter((r) => r.status === "fulfilled");
    assert.equal(
      fixedWinners.length,
      1,
      "fixed single-get etag stale-break must not double-win under the same forced window",
    );
    await fixedAdapter.close();
  });

  it("barrier stale-break with settle 0: only one holder after forced race window", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const key = lockRelativePath(LAYOUT_PREFIX, LOCK_NAME);
    const stalePayload = {
      owner_dev_h: DEV_A,
      nonce: "barrier-stale",
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
    };
    const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
      ic_layout_lease_lock_v1: stalePayload,
    });
    await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealed), { ifNoneMatch: "*" });

    /** @type {() => void} */
    let releaseStaleBreak;
    const staleBreakPaused = new Promise((resolve) => {
      releaseStaleBreak = resolve;
    });
    setLeaseLockStaleBreakBarrierForTests(() => staleBreakPaused);

    const aPromise = acquireLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: LOCK_NAME,
      ownerDevH: DEV_A,
      settleMs: 0,
    });
    const bPromise = acquireLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: LOCK_NAME,
      ownerDevH: DEV_B,
      settleMs: 0,
    });
    await sleep(20);
    releaseStaleBreak();
    const [aSettled, bSettled] = await Promise.allSettled([aPromise, bPromise]);
    const winners = [aSettled, bSettled].filter((r) => r.status === "fulfilled");
    assert.equal(winners.length, 1, "forced race must produce exactly one successful acquire");

    const winner = /** @type {PromiseFulfilledResult<{ nonce: string, ownerDevH?: string }>} */ (winners[0])
      .value;
    const dev = aSettled.status === "fulfilled" ? DEV_A : DEV_B;
    await readLeaseLockForFence({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: LOCK_NAME,
      ownerDevH: dev,
      nonce: winner.nonce,
    });
    await adapter.close();
  });
});
