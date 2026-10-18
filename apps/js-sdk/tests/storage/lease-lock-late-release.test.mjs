import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
  releaseLeaseLock,
  renewLeaseLock,
} from "../../lib/storage/lease-lock.mjs";
import { deriveDevH, lockRelativePath } from "../../lib/storage/layout.mjs";

const TEST_DEK = new Uint8Array(32).fill(9);
const DEV_A = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
const DEV_B = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
const LAYOUT_PREFIX = "acct/lease-late";

/** See also `lease-lock-owner.test.mjs` for concurrent renew/release vs stale-break. */
describe("lease lock late release (audit S2)", () => {
  it("late release by A does not delete B's live lock", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();

    const stalePayload = {
      owner_dev_h: DEV_A,
      nonce: "stale-nonce",
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
    };
    const key = lockRelativePath(LAYOUT_PREFIX, "shared.manifest");
    const { encryptVaultPlaintextForStoragePut } = await import("../../lib/storage/encrypt-storage-object.mjs");
    const { copyVerifiedStoragePutBodyForAdapter } = await import("../../lib/storage/encrypt-storage-object.mjs");
    const sealedStale = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
      ic_layout_lease_lock_v1: stalePayload,
    });
    await adapter.put(key, copyVerifiedStoragePutBodyForAdapter(sealedStale), { ifNoneMatch: "*" });

    const lockB = await acquireLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "shared.manifest",
      ownerDevH: DEV_B,
      settleMs: 0,
    });

    await releaseLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "shared.manifest",
      ownerDevH: DEV_A,
      nonce: stalePayload.nonce,
    });

    await renewLeaseLock({
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT_PREFIX,
      lockName: "shared.manifest",
      ownerDevH: DEV_B,
      nonce: lockB.nonce,
    });
    await adapter.close();
  });
});
