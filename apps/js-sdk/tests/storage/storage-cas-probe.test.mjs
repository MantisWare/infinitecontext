import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { probeCrossDeviceCas } from "../../lib/storage/storage-cas-probe.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";

describe("probeCrossDeviceCas", () => {
  it("returns true for a fully conditional memory adapter", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    assert.equal(await probeCrossDeviceCas(adapter), true);
    await adapter.close();
  });

  it("returns false when If-None-Match:* is ignored on an existing key", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const adapter = {
      ...inner,
      async put(key, body, opts) {
        if (opts?.ifNoneMatch === "*" && (await inner.head(key))) {
          return inner.put(key, body, {});
        }
        return inner.put(key, body, opts);
      },
      capabilities: inner.capabilities,
    };
    assert.equal(await probeCrossDeviceCas(adapter), false);
    await inner.close();
  });

  it("returns false when If-Match is ignored", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const adapter = {
      ...inner,
      async put(key, body, opts) {
        if (opts?.ifMatch !== undefined) {
          return inner.put(key, body, {});
        }
        return inner.put(key, body, opts);
      },
      capabilities: inner.capabilities,
    };
    assert.equal(await probeCrossDeviceCas(adapter), false);
    await inner.close();
  });

  it("requires PreconditionFailedError on duplicate ifNoneMatch create", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const key = "probe/inm.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(
      () => adapter.put(key, body, { ifNoneMatch: "*" }),
      (err) => err instanceof PreconditionFailedError,
    );
    await adapter.close();
  });
});
