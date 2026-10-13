import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { probeKeyringSecretService } from "../../lib/storage/secret-store-keyring-probe.mjs";
import { readBackendMarker } from "../../lib/storage/secret-store-marker.mjs";
import { platformKeychainMarkerId, SecretStore } from "../../lib/storage/secret-store.mjs";

const SAMPLE_SECRET = new TextEncoder().encode("ci-keyring-round-trip");

describe("Secret store keyring (CI Secret Service)", () => {
  it("probe succeeds and round-trips a secret via Secret Service", async (t) => {
    if (!(await probeKeyringSecretService())) {
      t.skip("Secret Service probe failed in this environment");
      return;
    }
    const expectedMarker = platformKeychainMarkerId();
    assert.ok(expectedMarker);
    if (process.platform === "linux") {
      assert.equal(expectedMarker, "secret-service");
    }

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-ci-keyring-"));
    const name = `ci/secret/${Date.now()}`;
    const store = new SecretStore({ mode: "keyring", rootDir });
    assert.equal(await store.backendKind(), expectedMarker);
    assert.equal(readBackendMarker(rootDir), expectedMarker);
    await store.set(name, SAMPLE_SECRET);
    assert.deepEqual(await store.get(name), SAMPLE_SECRET);
    assert.equal(await store.delete(name), true);
    assert.equal(await store.get(name), null);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
