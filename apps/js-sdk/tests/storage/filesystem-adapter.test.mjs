import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  runStorageAdapterContractSuite,
  sampleEncryptedObjectBytesForKey,
  sampleEncryptedObjectBytesVariant,
} from "../../lib/storage/contract-suite.mjs";
import { StorageError } from "../../lib/storage/errors.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

const RACE_PROCESSES = 8;
const CAS_ROUNDS = 4;
const WORKER = fileURLToPath(new URL("./filesystem-race-worker.mjs", import.meta.url));

/** @param {string[]} argv @returns {Promise<string>} */
function runWorker(argv) {
  return new Promise((resolve, reject) => {
    /** @type {string[]} */
    const lines = [];
    const child = spawn(process.execPath, argv, { env: process.env });
    child.stdout.on("data", (chunk) => lines.push(String(chunk)));
    child.stderr.on("data", (chunk) => lines.push(String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(lines.join("").trim());
      } else {
        reject(new Error(`worker failed (${code}): ${lines.join("")}`));
      }
    });
  });
}

runStorageAdapterContractSuite(
  async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-storage-"));
    const adapter = createFilesystemStorageAdapter({ rootDir, exposeInternalsForTests: true });
    return {
      adapter,
      inspectBacking: () => {
        const snap = adapter.exposeInternalsForTests?.();
        assert.ok(snap);
        return snap;
      },
    };
  },
  { describe, it },
);

describe("filesystem storage adapter", () => {
  it("persists ciphertext across adapter re-open", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-storage-reopen-"));
    const key = "persist/obj.enc";
    const body = sampleEncryptedObjectBytesForKey(key);

    const writer = createFilesystemStorageAdapter({ rootDir });
    await writer.init();
    await writer.put(key, body, { ifNoneMatch: "*" });
    await writer.close();

    const reader = createFilesystemStorageAdapter({ rootDir });
    await reader.init();
    const got = await reader.get(key);
    assert.deepEqual(got?.body, body);
    await reader.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("rejects symlink escape under the store root", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-storage-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-outside-"));
    fs.mkdirSync(path.join(rootDir, "objects"), { recursive: true });
    fs.symlinkSync(outside, path.join(rootDir, "objects", "escape"));

    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await assert.rejects(
      () => adapter.get("escape/obj.enc"),
      (error) => error instanceof StorageError,
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it(`${RACE_PROCESSES} processes: exactly one ifNoneMatch:* create winner`, async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-race-create-"));
    const results = await Promise.all(
      Array.from({ length: RACE_PROCESSES }, (_, i) =>
        runWorker([WORKER, rootDir, "create", String(i)]),
      ),
    );
    const wins = results.filter((line) => line.includes("CREATE_WIN")).length;
    const loses = results.filter((line) => line.includes("CREATE_LOSE")).length;
    assert.equal(wins, 1);
    assert.equal(loses, RACE_PROCESSES - 1);
    console.log(
      `IC_FS_RACE_CREATE: processes=${RACE_PROCESSES} create_wins=${wins} create_loses=${loses}`,
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it(`${RACE_PROCESSES} processes × ${CAS_ROUNDS} rounds: exactly one ifMatch winner per round`, async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-race-cas-"));
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    const key = "race/multiprocess/object.enc";
    const seed = sampleEncryptedObjectBytesForKey(key);
    const created = await adapter.put(key, seed, { ifNoneMatch: "*" });
    await adapter.close();

    let totalCasWins = 0;
    let totalCasLoses = 0;
    let etag = created.etag;
    for (let round = 0; round < CAS_ROUNDS; round += 1) {
      const results = await Promise.all(
        Array.from({ length: RACE_PROCESSES }, (_, i) =>
          runWorker([WORKER, rootDir, "cas", String(i), etag ?? ""]),
        ),
      );
      const wins = results.filter((line) => line.includes("CAS_WIN")).length;
      const loses = results.filter((line) => line.includes("CAS_LOSE")).length;
      assert.equal(wins, 1);
      assert.equal(loses, RACE_PROCESSES - 1);
      totalCasWins += wins;
      totalCasLoses += loses;
      const reader = createFilesystemStorageAdapter({ rootDir });
      await reader.init();
      const head = await reader.head(key);
      etag = head?.etag;
      await reader.close();
    }
    console.log(
      `IC_FS_RACE_CAS: processes=${RACE_PROCESSES} rounds=${CAS_ROUNDS} cas_wins=${totalCasWins} cas_loses=${totalCasLoses}`,
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
