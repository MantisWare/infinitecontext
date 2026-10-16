import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  sampleEncryptedObjectBytesForKey,
  sampleEncryptedObjectBytesVariant,
} from "../../lib/storage/contract-suite.mjs";
import { probeCrossDeviceCasRace } from "../../lib/storage/storage-cas-race-probe.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";

describe("probeCrossDeviceCasRace", () => {
  it("passes when parallel puts are serialized (linearizable adapter)", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    const adapter = {
      ...inner,
      put(key, body, opts) {
        const run = () => inner.put(key, body, opts);
        const next = chain.then(run, run);
        chain = next.then(() => {}, () => {});
        return next;
      },
      delete(key, opts) {
        return inner.delete(key, opts);
      },
      capabilities: inner.capabilities,
    };
    const result = await probeCrossDeviceCasRace(adapter, { rounds: 5 });
    assert.equal(result.ok, true);
    const listed = await inner.list("ic-cas-race/");
    assert.equal(listed.objects.length, 0);
    await inner.close();
  });

  it("detects double-win when If-None-Match is ignored", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const adapter = {
      ...inner,
      put(key, body, opts) {
        if (opts?.ifNoneMatch === "*") {
          return inner.put(key, body, {});
        }
        return inner.put(key, body, opts);
      },
      capabilities: inner.capabilities,
    };
    const result = await probeCrossDeviceCasRace(adapter, { rounds: 3 });
    assert.equal(result.ok, false);
    assert.equal(result.detail, "double_win");
    await inner.close();
  });

  it("requires PreconditionFailedError rather than silent success on duplicate create", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const key = "ic-cas-race/manual.probe";
    const body = sampleEncryptedObjectBytesForKey(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(
      () => adapter.put(key, sampleEncryptedObjectBytesVariant(key, 0xcc), { ifNoneMatch: "*" }),
      (err) => err instanceof PreconditionFailedError,
    );
    await adapter.close();
  });
});
