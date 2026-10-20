import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  readLeaseLockForFence,
} from "../../lib/storage/lease-lock.mjs";
import { lockRelativePath } from "../../lib/storage/layout.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import {
  RACE_DEV_A,
  RACE_DEV_B,
  RACE_LAYOUT_PREFIX,
  RACE_LOCK_NAME,
  RACE_TEST_DEK,
  runFirstGetBarrierStaleBreakRace,
} from "./lease-lock-race-harness.mjs";

const DEV_A = RACE_DEV_A;
const LAYOUT_PREFIX = RACE_LAYOUT_PREFIX;

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

describe("lease lock stale-break regression guard (honest memory adapter)", () => {
  it("stale-break delete uses etag from the first get (head drift rejects wrong etag)", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const key = lockRelativePath(LAYOUT_PREFIX, "drift");
    const payload = {
      owner_dev_h: DEV_A,
      nonce: "stale-nonce",
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
    };
    const sealed = encryptVaultPlaintextForStoragePut(RACE_TEST_DEK, key, {
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

  it("regression guard: first-get barrier race (settle 0) allows only one holder at head", async () => {
    const { winners, adapter } = await runFirstGetBarrierStaleBreakRace();
    assert.equal(
      winners.length,
      1,
      "single-get stale-break must not double-win when B acquires during first-get pause",
    );
    await adapter.close();
  });

  it("first-get barrier race: winning nonce matches read-back fence", async () => {
    const { winners, adapter } = await runFirstGetBarrierStaleBreakRace();
    assert.equal(winners.length, 1);

    const winner = /** @type {PromiseFulfilledResult<{ nonce: string }>} */ (winners[0]).value;
    const fenceOpts = {
      adapter,
      dek: RACE_TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: RACE_LOCK_NAME,
      nonce: winner.nonce,
    };
    try {
      await readLeaseLockForFence({ ...fenceOpts, ownerDevH: RACE_DEV_A });
    } catch {
      await readLeaseLockForFence({ ...fenceOpts, ownerDevH: RACE_DEV_B });
    }
    await adapter.close();
  });
});
