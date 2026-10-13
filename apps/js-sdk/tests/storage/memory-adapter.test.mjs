import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { runStorageAdapterContractSuite, sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";

runStorageAdapterContractSuite(
  async () => {
    const adapter = createMemoryStorageAdapter({ exposeInternalsForTests: true });
    return {
      adapter,
      inspectBacking: () => adapter.exposeInternalsForTests(),
    };
  },
  { describe, it },
);

describe("memory storage adapter — AAD at rest", () => {
  it("fails contract backing scan when AAD is stripped at rest", async () => {
    const adapter = createMemoryStorageAdapter({
      exposeInternalsForTests: true,
      corruptStripAadForTests: true,
    });
    await adapter.init();
    const key = "aad/strip.enc";
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    const snap = adapter.exposeInternalsForTests();
    const idx = snap.keys.indexOf(key);
    assert.ok(idx >= 0);
    assert.throws(() => {
      const body = snap.bodies[idx];
      const text = new TextDecoder().decode(body);
      const parsed = JSON.parse(text);
      if (!parsed.aad) {
        throw new Error("missing aad at rest");
      }
    });
  });
});
