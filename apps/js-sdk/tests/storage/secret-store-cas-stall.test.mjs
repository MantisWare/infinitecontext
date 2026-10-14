import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { STALE_LOCK_MTIME_MS } from "../../lib/storage/secret-store-heartbeat-lock.mjs";
import { SecretStore } from "../../lib/storage/secret-store.mjs";

const STALL_WORKER = fileURLToPath(new URL("./secret-store-stall-worker.mjs", import.meta.url));
const STALL_MS = STALE_LOCK_MTIME_MS + 2_000;

/** @param {string[]} args */
function runWorker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === 2) {
        resolve(code ?? 0);
      } else {
        reject(new Error(`worker exited with code ${code}`));
      }
    });
  });
}

describe("Secret store CAS commit vs stale lock", () => {
  it("preserves both writes when one commit stalls past lock staleness", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-cas-stall-"));
    const store = new SecretStore({ mode: "file", rootDir });
    await store.set("seed", new Uint8Array([1]));

    const slowArgs = [STALL_WORKER, rootDir, "slow-key", String(STALL_MS)];
    const slowPromise = runWorker(slowArgs);
    await new Promise((resolve) => setTimeout(resolve, STALE_LOCK_MTIME_MS + 500));
    const fastExit = await runWorker([STALL_WORKER, rootDir, "fast-key", "0"]);
    assert.equal(fastExit, 0);

    let slowExit = await slowPromise;
    if (slowExit === 2) {
      await store.set("slow-key", new TextEncoder().encode("value-for-slow-key"));
      slowExit = 0;
    }
    assert.equal(slowExit, 0);

    assert.deepEqual(await store.get("fast-key"), new TextEncoder().encode("value-for-fast-key"));
    assert.deepEqual(await store.get("slow-key"), new TextEncoder().encode("value-for-slow-key"));
    console.log("IC_SECRET_STORE_CAS_STALL: both_keys_present=true slow_retried=" + (slowExit === 0));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
