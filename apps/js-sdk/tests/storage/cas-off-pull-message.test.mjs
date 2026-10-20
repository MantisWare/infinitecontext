import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryObjectStoreLocalState } from "../../lib/object-store-local-sync-state.mjs";
import {
  CAS_CONDITIONAL_WRITES_DOCTOR_HINT,
  CasConditionalWritesUnconfirmedError,
} from "../../lib/storage/cas-conditional-user-error.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  assertStorageDeletePreconditionsSupported,
  assertStoragePutPreconditionsSupported,
} from "../../lib/storage/storage-put-preconditions.mjs";
import { confirmObjectStorePullDelivery } from "../../lib/storage/storage-compaction.mjs";
import { deriveDevH, manifestEncRelativePath } from "../../lib/storage/layout.mjs";
import { formatSyncCliError } from "../../lib/sync-errors.mjs";
import { STORAGE_CAPABILITIES, storageCapabilitySet } from "../../lib/storage/types.mjs";

const TEST_DEK = new Uint8Array(32).fill(4);
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT = "accounts/cas-off-test";

/** Simulates S3 init with a poisoned CAS cache (crossDeviceCas off, no conditional writes). */
async function createCasOffMemoryAdapter() {
  const inner = createMemoryStorageAdapter();
  await inner.init();
  const caps = storageCapabilitySet([
    STORAGE_CAPABILITIES.get,
    STORAGE_CAPABILITIES.head,
    STORAGE_CAPABILITIES.put,
    STORAGE_CAPABILITIES.list,
    STORAGE_CAPABILITIES.delete,
  ]);
  return {
    ...inner,
    capabilities: caps,
    put(key, body, putOptions) {
      assertStoragePutPreconditionsSupported({ capabilities: caps }, putOptions);
      return inner.put(key, body, putOptions);
    },
    delete(key, deleteOptions) {
      assertStorageDeletePreconditionsSupported({ capabilities: caps }, deleteOptions);
      return inner.delete(key, deleteOptions);
    },
  };
}

describe("CAS off — pull delivery user message (T4)", () => {
  it("confirmPullDelivery maps conditional-create NotSupportedError to doctor hint", async () => {
    const adapter = await createCasOffMemoryAdapter();
    const localState = createInMemoryObjectStoreLocalState();
    const selfDevH = deriveDevH(TEST_DEK, DEVICE_B);
    const manifestKey = manifestEncRelativePath(LAYOUT);
    assert.equal(await adapter.get(manifestKey), null);

    const ctx = {
      adapter,
      dek: TEST_DEK,
      layoutPrefix: LAYOUT,
      selfDevH,
      deviceUuid: DEVICE_B,
      localState,
    };

    await assert.rejects(
      () => confirmObjectStorePullDelivery(ctx),
      (err) => {
        assert.ok(err instanceof CasConditionalWritesUnconfirmedError);
        assert.match(String(err.message), /storage doctor --recheck-cas/);
        assert.doesNotMatch(String(err.stack ?? ""), /NotSupportedError/);
        return true;
      },
    );

    assert.equal(await adapter.get(manifestKey), null);
    await adapter.close();
  });

  it("formatSyncCliError surfaces the friendly CAS message without NotSupportedError", () => {
    const friendly = new CasConditionalWritesUnconfirmedError();
    const text = formatSyncCliError(friendly);
    assert.equal(text, CAS_CONDITIONAL_WRITES_DOCTOR_HINT);
    assert.doesNotMatch(text, /NotSupportedError/);
  });

  it("adapter without conditionalCreate matches casUnsafe crossDeviceCas-off behaviour", async () => {
    const adapter = await createCasOffMemoryAdapter();
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalCreate), false);
    await adapter.close();
  });
});
