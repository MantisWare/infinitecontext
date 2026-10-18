/**
 * Run only for scratch double-get proof: IC_LEASE_SCRATCH_PROOF=1 with lease-lock.mjs patched to second-get stale-break.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it } from "node:test";

import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import {
  LEASE_CLOCK_SKEW_MARGIN_MS,
  LEASE_LOCK_TTL_MS,
  acquireLeaseLock,
} from "../../lib/storage/lease-lock.mjs";
import { canonicalDevH, deriveDevH, lockRelativePath } from "../../lib/storage/layout.mjs";
import { leaseExpiresAtMs } from "../../lib/storage/lease-lock.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import { decryptVaultStorageObjectPlaintext } from "../../lib/storage/storage-object-move.mjs";

if (process.env.IC_LEASE_SCRATCH_PROOF !== "1") {
  describe("lease scratch proof (skipped)", () => {
    it("skipped unless IC_LEASE_SCRATCH_PROOF=1", () => {});
  });
} else {
  const TEST_DEK = new Uint8Array(32).fill(9);
  const DEV_A = deriveDevH(TEST_DEK, "11111111-1111-4111-8111-111111111111");
  const DEV_B = deriveDevH(TEST_DEK, "22222222-2222-4222-8222-222222222222");
  const LAYOUT_PREFIX = "acct/scratch-proof";
  const LOCK_NAME = "race";

  const acquireGetContext = new AsyncLocalStorage();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Models list-after-write returning a stale etag on the second get (77db470 class bug). */
  function createSecondGetStaleEtagAdapter(dek, layoutPrefix, lockName, awaitBarrier) {
    /** @type {Map<string, { body: Uint8Array, etag: string }>} */
    const store = new Map();
    /** @type {Map<string, string>} */
    const readBackNonceByOwner = new Map();
    const key = lockRelativePath(layoutPrefix, lockName);
    const etag = () => `"${crypto.randomUUID()}"`;

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
          return { body: entry.body, etag: `${entry.etag}-stale-head` };
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
        const ok =
          ifMatch === undefined || ifMatch === live || ifMatch === `${live}-stale-head`;
        if (!ok) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        store.delete(storageKey);
      },
      async put(storageKey, body, { ifNoneMatch } = {}) {
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
        if (ifNoneMatch === "*" && store.has(storageKey)) {
          return;
        }
        store.set(storageKey, { body, etag: etag() });
      },
      async seed(body) {
        store.set(key, { body, etag: etag() });
      },
    };
  }

  async function runScratchRace() {
    let release;
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const adapter = createSecondGetStaleEtagAdapter(
      TEST_DEK,
      LAYOUT_PREFIX,
      LOCK_NAME,
      async () => {
        waiting += 1;
        if (waiting >= 2) {
          release();
        }
        await paused;
      },
    );
    const stalePayload = {
      owner_dev_h: DEV_A,
      nonce: "stale",
      expires_at_ms: Date.now() - LEASE_LOCK_TTL_MS - LEASE_CLOCK_SKEW_MARGIN_MS - 1,
    };
    const sealed = encryptVaultPlaintextForStoragePut(
      TEST_DEK,
      lockRelativePath(LAYOUT_PREFIX, LOCK_NAME),
      { ic_layout_lease_lock_v1: stalePayload },
    );
    await adapter.seed(copyVerifiedStoragePutBodyForAdapter(sealed));

    const run = (ownerDevH) =>
      acquireGetContext.run({ getCount: 0, ownerDevH }, () =>
        acquireLeaseLock({
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT_PREFIX,
          lockName: LOCK_NAME,
          ownerDevH,
          settleMs: 0,
        }),
      );

    const a = run(DEV_A);
    const b = run(DEV_B);
    a.catch(() => {});
    b.catch(() => {});
    await sleep(30);
    if (waiting < 2) {
      release();
    }
    const results = await Promise.allSettled([a, b]);
    return results.filter((r) => r.status === "fulfilled");
  }

  describe("lease scratch double-get proof", () => {
    it("double-get stale-break yields two holders (regression test must fail)", async () => {
      const winners = await runScratchRace();
      assert.equal(winners.length, 2, "patched 77db470-style stale-break should double-win");
    });
  });
}
