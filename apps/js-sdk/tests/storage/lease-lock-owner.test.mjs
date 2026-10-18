import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
  leaseExpiresAtMs,
  readLeaseLockForFence,
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

/** Per-acquire get() count — second get() returns a duplicate etag (77db470 storage bug model). */
const acquireGetContext = new AsyncLocalStorage();

/**
 * In-memory adapter for stale-break race tests: barrier between read path and delete(),
 * duplicate etag on the second get() within one acquire, and read-back rows per owner after put.
 *
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 * @param {string} lockName
 * @param {() => void | Promise<void>} awaitBarrier
 */
function createStaleBreakBarrierAdapter(dek, layoutPrefix, lockName, awaitBarrier) {
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
      const ctx = acquireGetContext.getStore();
      if (ctx) {
        ctx.getCount += 1;
      }
      const owner = ctx?.ownerDevH ? canonicalDevH(ctx.ownerDevH) : null;
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
        const entry = store.get(storageKey);
        return {
          body: copyVerifiedStoragePutBodyForAdapter(sealed),
          etag: entry?.etag ?? etag(),
        };
      }
      const entry = store.get(storageKey);
      if (!entry) {
        return null;
      }
      if (ctx && ctx.getCount >= 2) {
        return { body: entry.body, etag: `${entry.etag}-second-get` };
      }
      return { body: entry.body, etag: entry.etag };
    },
    async delete(storageKey, { ifMatch } = {}) {
      await awaitBarrier();
      const entry = store.get(storageKey);
      if (!entry) {
        return;
      }
      const live = entry.etag;
      const matches =
        ifMatch === undefined || ifMatch === live || ifMatch === `${live}-second-get`;
      if (!matches) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      store.delete(storageKey);
    },
    async put(storageKey, body, { ifNoneMatch, ifMatch } = {}) {
      const ctx = acquireGetContext.getStore();
      if (ctx?.ownerDevH) {
        try {
          const plain = decryptVaultStorageObjectPlaintext(dek, storageKey, body);
          const payload = plain.ic_layout_lease_lock_v1;
          if (payload?.nonce) {
            readBackNonceByOwner.set(canonicalDevH(ctx.ownerDevH), String(payload.nonce));
          }
        } catch {
          /* ignore */
        }
      }
      const cur = store.get(storageKey);
      if (ifNoneMatch === "*" && cur) {
        if (process.env.IC_LEASE_PROVE_77DB470 === "1" && ctx?.ownerDevH) {
          return;
        }
        throw new PreconditionFailedError("Object already exists");
      }
      if (ifMatch && (!cur || cur.etag !== ifMatch)) {
        throw new PreconditionFailedError("ifMatch precondition failed");
      }
      store.set(storageKey, { body, etag: etag() });
    },
    async head(storageKey) {
      const entry = store.get(storageKey);
      if (!entry) {
        return null;
      }
      return { etag: entry.etag };
    },
    async seedStale(body) {
      store.set(key, { body, etag: etag() });
    },
  };
}

function runAcquireInContext(options) {
  return acquireGetContext.run(
    { getCount: 0, ownerDevH: options.ownerDevH },
    () => acquireLeaseLock(options),
  );
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
  const body = copyVerifiedStoragePutBodyForAdapter(sealed);
  if (typeof adapter.seedStale === "function") {
    await adapter.seedStale(body);
    return;
  }
  await adapter.put(key, body, { ifNoneMatch: "*" });
}

async function runForcedStaleBreakRace(lockName) {
  /** @type {() => void} */
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  const adapter = createStaleBreakBarrierAdapter(
    TEST_DEK,
    LAYOUT_PREFIX,
    lockName,
    async () => {
      waiting += 1;
      if (waiting >= 2) {
        release();
      }
      await paused;
    },
  );
  await seedStaleLock(adapter, lockName);

  const aPromise = runAcquireInContext({
    adapter,
    dek: TEST_DEK,
    layoutPrefix: LAYOUT_PREFIX,
    lockName,
    ownerDevH: DEV_A,
    settleMs: 0,
  });
  const bPromise = runAcquireInContext({
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
  return { winners: results.filter((r) => r.status === "fulfilled"), adapter };
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
