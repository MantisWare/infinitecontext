import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { STALE_LOCK_MTIME_MS } from "../../lib/storage/secret-store-heartbeat-lock.mjs";
import { storageSecretFilePaths } from "../../lib/storage/secret-store-file.mjs";
import { SecretStore } from "../../lib/storage/secret-store.mjs";

const WRITERS = 24;
const TRIALS = 12;

describe("Secret store heartbeat lock stress", () => {
  it(`retains all writes with ${WRITERS} concurrent writers on a dead lock (${TRIALS} trials)`, async () => {
    let totalWrites = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `ic-secret-lock-stress-${trial}-`));
      const { lockPath } = storageSecretFilePaths(rootDir);
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(lockPath, "dead-lock-token-from-crash", { mode: 0o600 });
      const stale = new Date(Date.now() - STALE_LOCK_MTIME_MS - 5_000);
      fs.utimesSync(lockPath, stale, stale);

      const store = new SecretStore({ mode: "file", rootDir });
      await Promise.all(
        Array.from({ length: WRITERS }, (_, i) => {
          const value = new TextEncoder().encode(`trial-${trial}-writer-${i}`);
          return store.set(`stress/${trial}/${i}`, value);
        }),
      );

      for (let i = 0; i < WRITERS; i += 1) {
        const got = await store.get(`stress/${trial}/${i}`);
        assert.deepEqual(got, new TextEncoder().encode(`trial-${trial}-writer-${i}`));
      }
      totalWrites += WRITERS;
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    console.log(
      `IC_SECRET_STORE_LOCK_STRESS: trials=${TRIALS} writers_per_trial=${WRITERS} total_ack_writes=${totalWrites} lost=0`,
    );
  });
});
