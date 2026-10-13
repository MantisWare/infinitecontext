import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeKeyringSecretService } from "../../lib/storage/secret-store-keyring-probe.mjs";
import { SecretStore } from "../../lib/storage/secret-store.mjs";

const SAMPLE_SECRET = new TextEncoder().encode("ci-keyring-round-trip");

describe("Secret store keyring (CI Secret Service)", () => {
  it("probe succeeds and round-trips a secret", async (t) => {
    if (!(await probeKeyringSecretService())) {
      t.skip("Secret Service probe failed in this environment");
    }
    const name = `ci/secret/${Date.now()}`;
    const store = new SecretStore({ mode: "keyring" });
    assert.equal(await store.backendKind(), "keyring");
    await store.set(name, SAMPLE_SECRET);
    assert.deepEqual(await store.get(name), SAMPLE_SECRET);
    assert.equal(await store.delete(name), true);
    assert.equal(await store.get(name), null);
  });
});
