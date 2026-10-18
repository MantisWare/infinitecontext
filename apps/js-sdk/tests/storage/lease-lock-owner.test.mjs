import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
  readLeaseLockForFence,
  releaseLeaseLock,
  renewLeaseLock,
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

/** Stale-break path from head()-based lease-lock (77db470) — must not pass drift test. */
async function staleBreakDeleteUsingHead(adapter, key) {
  const head = await adapter.head(key);
  if (head?.etag) {
    await adapter.delete(key, { ifMatch: head.etag });
  }
}

/** Current get()-etag stale-break delete. */
async function staleBreakDeleteUsingGet(adapter, key) {
  const row = await adapter.get(key);
  if (row?.etag) {
    await adapter.delete(key, { ifMatch: row.etag });
  }
}

describe("lease lock owner etag races (QA #4)", () => {
  it("stale-break must delete with get() etag; head()-only delete fails when head drifts", async () => {
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
    const row = await inner.get(key);
    assert.ok(row?.etag);

    const drift = wrapHeadEtagDrift(inner, '"stale-head-etag"');
    await assert.rejects(
      () => staleBreakDeleteUsingHead(drift, key),
      (err) => err instanceof PreconditionFailedError,
    );
    assert.ok(await inner.get(key), "head()-etag stale-break must not remove object when head drifts");

    await staleBreakDeleteUsingGet(drift, key);
    assert.equal(await inner.get(key), null, "get()-etag stale-break must remove object");
    await inner.close();
  });

  it("concurrent renew/release vs stale-break acquire never double-holds", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();

    const lockA = await acquireLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: LOCK_NAME,
      ownerDevH: DEV_A,
      settleMs: 0,
    });

    const key = lockRelativePath(LAYOUT_PREFIX, LOCK_NAME);
    const row = await adapter.get(key);
    assert.ok(row?.etag);
    const stalePayload = {
      owner_dev_h: DEV_A,
      nonce: lockA.nonce,
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 5,
    };
    const sealedStale = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
      ic_layout_lease_lock_v1: stalePayload,
    });
    await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealedStale), { ifMatch: row.etag });

    const outcomes = await Promise.allSettled([
      renewLeaseLock({
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        lockName: LOCK_NAME,
        ownerDevH: DEV_A,
        nonce: lockA.nonce,
      }),
      acquireLeaseLock({
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        lockName: LOCK_NAME,
        ownerDevH: DEV_B,
        settleMs: 0,
      }),
      releaseLeaseLock({
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        lockName: LOCK_NAME,
        ownerDevH: DEV_A,
        nonce: lockA.nonce,
      }),
    ]);

    const acquiredB = outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
    const renewedA = outcomes[0].status === "fulfilled";

    let liveHolders = 0;
    if (renewedA) {
      liveHolders += 1;
      await readLeaseLockForFence({
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        lockName: LOCK_NAME,
        ownerDevH: DEV_A,
        nonce: lockA.nonce,
      });
    }
    if (acquiredB) {
      liveHolders += 1;
      await readLeaseLockForFence({
        adapter,
        dek: TEST_DEK,
        layoutPrefix: LAYOUT_PREFIX,
        lockName: LOCK_NAME,
        ownerDevH: DEV_B,
        nonce: acquiredB.nonce,
      });
    }

    assert.ok(liveHolders <= 1, "renew/stale-break race must not leave two live holders");
    await adapter.close();
  });
});
