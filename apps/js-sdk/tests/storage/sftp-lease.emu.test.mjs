import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, after } from "node:test";

import {
  acquireLeaseLock,
  releaseLeaseLock,
  withLeaseLock,
} from "../../lib/storage/lease-lock.mjs";
import { readSftpPrivateKeyFile, createSftpStorageAdapter } from "../../lib/storage/sftp-adapter.mjs";
import { deriveDevH } from "../../lib/storage/layout.mjs";
import { getSftpEmuConfig, teardownSftpEmu } from "./helpers/sftp-emu-lazy.mjs";

const emu = getSftpEmuConfig();
const TEST_DEK = new Uint8Array(32).fill(5);
const LAYOUT = "accounts/sftp-lease";
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

if (process.env.IC_REQUIRE_SFTP === "1") {
  after(() => {
    teardownSftpEmu();
  });
}

/** @param {NonNullable<typeof emu>} cfg */
async function createAdapter(cfg) {
  const { key } = readSftpPrivateKeyFile(cfg.privateKeyPath);
  const adapter = createSftpStorageAdapter({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    root: cfg.root,
    hostKeySha256: cfg.hostKeySha256,
    privateKey: key,
  });
  await adapter.init();
  return adapter;
}

describe("sftp lease lock emu", { skip: !emu }, () => {
  it("50 rounds: exactly one concurrent holder", async () => {
    const cfg = emu;
    assert.ok(cfg);
    const adapter = await createAdapter(cfg);
    const ownerA = deriveDevH(DEVICE_A);
    const ownerB = deriveDevH(DEVICE_B);
    let overlap = 0;

    for (let round = 0; round < 50; round += 1) {
      const lockName = `round-${round}`;
      const results = await Promise.allSettled([
        withLeaseLock({
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT,
          lockName,
          ownerDevH: ownerA,
          settleMs: 100,
          fn: async () => {
            await new Promise((r) => setTimeout(r, 30));
          },
        }),
        withLeaseLock({
          adapter,
          dek: TEST_DEK,
          layoutPrefix: LAYOUT,
          lockName,
          ownerDevH: ownerB,
          settleMs: 100,
          fn: async () => {
            await new Promise((r) => setTimeout(r, 30));
          },
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      if (fulfilled.length > 1) {
        overlap += 1;
      }
    }
    assert.equal(overlap, 0);
    await adapter.close();
  });

  it("worker contention: one holder per round", async () => {
    const cfg = emu;
    assert.ok(cfg);
    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "sftp-lease-worker.mjs");
    const rounds = 10;
    /** @type {Promise<number>[]} */
    const jobs = [];
    for (let i = 0; i < rounds; i += 1) {
      jobs.push(
        new Promise((resolve, reject) => {
          const child = fork(workerPath, [], {
            env: {
              ...process.env,
              IC_SFTP_EMU_JSON: JSON.stringify(cfg),
              IC_LEASE_ROUND: String(i),
            },
            stdio: "inherit",
          });
          child.on("exit", (code) => {
            if (code === 0) resolve(code);
            else reject(new Error(`worker exit ${code}`));
          });
        }),
      );
    }
    await Promise.all(jobs);
  });
});
