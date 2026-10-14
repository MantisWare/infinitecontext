import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import { FS_GEN_HIGH_WATER_BASENAME } from "../../lib/storage/filesystem-object-file.mjs";
import {
  formatObjectGenerationFileName,
  listAllObjectKeys,
  listGenerationPathsForKeyDir,
  loadLatestObjectGeneration,
  objectKeyDirectory,
  readGenerationHighWater,
  setFilesystemTombstoneSweepMaxAgeMsForTests,
  setFilesystemTombstoneSweepPauseAfterMarkerMsForTests,
  writeGenerationHighWater,
} from "../../lib/storage/filesystem-generations.mjs";

const STALL_MS = 12_000;
const STALL_WORKER = fileURLToPath(new URL("./filesystem-object-stall-worker.mjs", import.meta.url));

/** @param {string[]} args */
function runWorker(args) {
  return new Promise((resolve, reject) => {
    /** @type {string[]} */
    const lines = [];
    const child = spawn(process.execPath, args, { env: process.env });
    child.stdout.on("data", (c) => lines.push(String(c)));
    child.stderr.on("data", (c) => lines.push(String(c)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, out: lines.join("") }));
  });
}

describe("filesystem tombstone age sweep", () => {
  it("keeps newest tombstone and prunes older generations on init", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-sweep-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);

    const key = "sweep/old-delete.enc";
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    await adapter.delete(key);
    await adapter.close();

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const latest = loadLatestObjectGeneration(rootDir, key);
    assert.ok(latest?.header.tombstone);
    assert.equal(latest.gen, 2);
    const tombPath = path.join(keyDir, formatObjectGenerationFileName(latest.gen));
    const stale = new Date(Date.now() - 5_000);
    fs.utimesSync(tombPath, stale, stale);

    const reopened = createFilesystemStorageAdapter({ rootDir });
    await reopened.init();
    assert.ok(listAllObjectKeys(rootDir).includes(key));
    assert.equal(readGenerationHighWater(keyDir), 2);
    assert.equal(fs.existsSync(path.join(keyDir, FS_GEN_HIGH_WATER_BASENAME)), true);
    assert.equal(listGenerationPathsForKeyDir(keyDir).length, 1);
    assert.ok(loadLatestObjectGeneration(rootDir, key)?.header.tombstone);
    assert.equal(await reopened.get(key), null);
    await reopened.close();

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("does not sweep tombstones when a newer live generation exists", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-sweep-live-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);

    const key = "sweep/recreated.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.delete(key);
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.close();

    const reopened = createFilesystemStorageAdapter({ rootDir });
    await reopened.init();
    assert.ok(listAllObjectKeys(rootDir).includes(key));

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("init skips corrupt keys during tombstone sweep", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-sweep-corrupt-"));
    const goodKey = "sweep/good.enc";
    const badKey = "sweep/bad.enc";
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(goodKey, sampleEncryptedObjectBytesForKey(goodKey), { ifNoneMatch: "*" });
    await adapter.close();

    const { keyDir: badDir, canonical } = objectKeyDirectory(rootDir, badKey);
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, formatObjectGenerationFileName(1)),
      Buffer.from("not-a-valid-object-file"),
      { mode: 0o600 },
    );

    const reopened = createFilesystemStorageAdapter({ rootDir });
    await reopened.init();
    assert.ok(await reopened.get(goodKey));
    assert.throws(() => loadLatestObjectGeneration(rootDir, canonical));
    await reopened.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("corrupt high-water marker fails closed on read", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-bad-marker-"));
    const key = "sweep/bad-marker.enc";
    const { keyDir } = objectKeyDirectory(rootDir, key);
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(keyDir, FS_GEN_HIGH_WATER_BASENAME), "{not-json", { mode: 0o600 });
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await assert.rejects(() => adapter.get(key), (error) => error.code === "corrupt_storage");
    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

describe("filesystem tombstone sweep generation regression", () => {
  it("after sweep, create uses gen high_water+1 not gen 1", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-gen-create-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);
    const key = "sweep/gen-create.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    await adapter.delete(key);
    await adapter.close();

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const tomb = loadLatestObjectGeneration(rootDir, key);
    const tombPath = path.join(keyDir, formatObjectGenerationFileName(tomb.gen));
    fs.utimesSync(tombPath, new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));

    const swept = createFilesystemStorageAdapter({ rootDir });
    await swept.init();
    assert.equal(readGenerationHighWater(keyDir), 2);

    await swept.put(key, body, { ifNoneMatch: "*" });
    const gens = listGenerationPathsForKeyDir(keyDir);
    assert.equal(gens[0]?.gen, 3);

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    await swept.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("after sweep, stale ifMatch cannot resurrect a deleted object", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-gen-resurrect-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);
    const key = "sweep/gen-resurrect.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    const live = await adapter.get(key);
    assert.ok(live?.etag);
    await adapter.delete(key);
    await adapter.close();

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const tomb = loadLatestObjectGeneration(rootDir, key);
    fs.utimesSync(
      path.join(keyDir, formatObjectGenerationFileName(tomb.gen)),
      new Date(Date.now() - 5_000),
      new Date(Date.now() - 5_000),
    );

    const swept = createFilesystemStorageAdapter({ rootDir });
    await swept.init();
    await assert.rejects(
      () => swept.put(key, body, { ifMatch: live.etag }),
      PreconditionFailedError,
    );
    assert.equal(await swept.get(key), null);

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    await swept.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("high-water alone prevents generation regression", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-high-water-"));
    const key = "sweep/high-water-only.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const { keyDir } = objectKeyDirectory(rootDir, key);
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(keyDir, FS_GEN_HIGH_WATER_BASENAME),
      `${JSON.stringify({ high_water: 5 })}\n`,
      { mode: 0o600 },
    );

    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    assert.equal(listGenerationPathsForKeyDir(keyDir)[0]?.gen, 6);
    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("repro C: stalled ifMatch writer across delete fails and does not restore live object", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-repro-c-"));
    const key = "stall/object.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const seed = createFilesystemStorageAdapter({ rootDir });
    await seed.init();
    await seed.put(key, body, { ifNoneMatch: "*" });
    const live = await seed.get(key);
    assert.ok(live?.etag);
    await seed.close();

    const workerPromise = runWorker([STALL_WORKER, rootDir, "update", String(STALL_MS)]);

    await new Promise((r) => setTimeout(r, 11_000));
    const interloper = createFilesystemStorageAdapter({ rootDir });
    await interloper.init();
    await interloper.delete(key);
    await interloper.close();

    const res = await workerPromise;
    assert.match(res.out, /STALL_RETRY|PreconditionFailedError|precondition_failed/);

    const reader = createFilesystemStorageAdapter({ rootDir });
    await reader.init();
    assert.equal(await reader.get(key), null);
    await reader.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("ignores an old live generation reappearing below high-water after sweep", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-sync-resurrect-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);
    const key = "sweep/sync-old-gen.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    const gen1Path = path.join(
      objectKeyDirectory(rootDir, key).keyDir,
      formatObjectGenerationFileName(1),
    );
    const gen1Bytes = fs.readFileSync(gen1Path);
    await adapter.delete(key);
    await adapter.close();

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const tomb = loadLatestObjectGeneration(rootDir, key);
    fs.utimesSync(
      path.join(keyDir, formatObjectGenerationFileName(tomb.gen)),
      new Date(Date.now() - 5_000),
      new Date(Date.now() - 5_000),
    );

    const swept = createFilesystemStorageAdapter({ rootDir });
    await swept.init();
    assert.equal(readGenerationHighWater(keyDir), 2);

    fs.writeFileSync(path.join(keyDir, formatObjectGenerationFileName(1)), gen1Bytes, {
      mode: 0o600,
    });

    assert.equal(await swept.get(key), null);
    await swept.close();
    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("marker-first sweep survives crash after marker write (legacy layout)", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-marker-crash-"));
    setFilesystemTombstoneSweepMaxAgeMsForTests(1_000);
    const key = "sweep/legacy-no-marker.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    await adapter.put(key, body, { ifNoneMatch: "*" });
    const gen1Path = path.join(objectKeyDirectory(rootDir, key).keyDir, formatObjectGenerationFileName(1));
    const gen1Bytes = fs.readFileSync(gen1Path);
    await adapter.delete(key);
    await adapter.close();

    const { keyDir } = objectKeyDirectory(rootDir, key);
    const tomb = loadLatestObjectGeneration(rootDir, key);
    fs.writeFileSync(path.join(keyDir, formatObjectGenerationFileName(1)), gen1Bytes, { mode: 0o600 });
    fs.utimesSync(
      path.join(keyDir, formatObjectGenerationFileName(tomb.gen)),
      new Date(Date.now() - 5_000),
      new Date(Date.now() - 5_000),
    );
    try {
      fs.unlinkSync(path.join(keyDir, FS_GEN_HIGH_WATER_BASENAME));
    } catch {
      // legacy layout had no marker
    }

    writeGenerationHighWater(rootDir, keyDir, tomb.gen);
    assert.equal(readGenerationHighWater(keyDir), tomb.gen);
    assert.ok(fs.existsSync(path.join(keyDir, formatObjectGenerationFileName(1))));

    const reopened = createFilesystemStorageAdapter({ rootDir });
    await reopened.init();
    assert.equal(await reopened.get(key), null);
    assert.equal(readGenerationHighWater(keyDir), tomb.gen);
    await reopened.close();

    setFilesystemTombstoneSweepMaxAgeMsForTests(7 * 24 * 60 * 60 * 1000);
    setFilesystemTombstoneSweepPauseAfterMarkerMsForTests(0);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("high-water marker writes only raise the value", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-tomb-hw-max-"));
    const { keyDir } = objectKeyDirectory(rootDir, "sweep/hw-max.enc");
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    assert.equal(writeGenerationHighWater(rootDir, keyDir, 3), 3);
    assert.equal(writeGenerationHighWater(rootDir, keyDir, 2), 3);
    assert.equal(readGenerationHighWater(keyDir), 3);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
