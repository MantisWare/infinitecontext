import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configureDaemonObjectStoreSyncTransport } from "../src/daemon.mjs";

describe("daemon object store bootstrap", () => {
  it("fails closed when bootstrap import fails and backend is not hosted", async () => {
    await assert.rejects(
      () =>
        configureDaemonObjectStoreSyncTransport({
          accountSyncLoaded: true,
          runtimeConfig: {
            storage: { backend: "local-filesystem", rootDir: "/tmp/ic-test-store" },
          },
          log: () => {},
          loadBootstrapModule: async () => {
            throw new Error("stub import failed");
          },
        }),
      /Local object store sync is required.*stub import failed/,
    );
  });

  it("warns and continues when bootstrap fails on hosted backend", async () => {
    const warnings = [];
    await configureDaemonObjectStoreSyncTransport({
      accountSyncLoaded: true,
      runtimeConfig: { storage: { backend: "hosted" } },
      log: (level, message) => {
        warnings.push(`${level}:${message}`);
      },
      loadBootstrapModule: async () => {
        throw new Error("stub import failed");
      },
    });
    assert.ok(warnings.some((w) => w.includes("Local object store sync transport not configured")));
  });
});
