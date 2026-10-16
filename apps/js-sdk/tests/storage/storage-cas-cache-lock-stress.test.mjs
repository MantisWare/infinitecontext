import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  getStorageCasCacheRecord,
  loadStorageCasCache,
  loadSalvagedEndpointsFromLastGood,
  markStorageCasUnsafePersisted,
  mutateStorageCasCache,
  recordStorageCasDoctorRaceSuccess,
  recordStorageCasDoctorRecheckSuccess,
  setStorageCasCacheRecord,
} from "../../lib/storage/storage-cas-cache.mjs";

const childScript = fileURLToPath(new URL("./storage-cas-cache-lock-stress-child.mjs", import.meta.url));

/**
 * @param {Record<string, unknown>} input
 */
function runStressChild(input) {
  const inputPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-stress-in-")),
    "input.json",
  );
  fs.writeFileSync(inputPath, JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const child = fork(childScript, [], {
      env: { ...process.env, IC_CAS_STRESS_INPUT: inputPath },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`stress child exited ${code}`));
    });
  });
}

/**
 * @param {Record<string, unknown>[]} inputs
 */
async function runStressChildrenParallel(inputs) {
  await Promise.all(inputs.map((input) => runStressChild(input)));
}

describe("storage CAS cache lock stress", () => {
  it("16 processes x 60 writes retain every record (blocker A1)", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-stress-writes-")), "cache.json");
    const bindingKey = "s3:stress:bucket:p";
    const workers = 16;
    const iterations = 60;
    /** @type {Record<string, unknown>[]} */
    const jobs = [];
    for (let workerId = 0; workerId < workers; workerId += 1) {
      jobs.push({ cachePath, mode: "writes", workerId, iterations, bindingKey });
    }
    await runStressChildrenParallel(jobs);
    const cache = loadStorageCasCache(cachePath);
    for (let workerId = 0; workerId < workers; workerId += 1) {
      const key = `${bindingKey}:worker:${workerId}`;
      assert.equal(cache.endpoints[key]?.probedAtMs, iterations - 1, key);
    }
    assert.equal(Object.keys(cache.endpoints).length, workers);
  });

  it("8 init-success writers cannot clear race_double_win (blocker A1)", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-stress-flag-")), "cache.json");
    const bindingKey = "s3:stress:bucket:race";
    const writers = 8;
    const iterations = 15;
    await runStressChild({ cachePath, mode: "flag-survival", workerId: 0, iterations: 1, bindingKey });
    /** @type {Record<string, unknown>[]} */
    const jobs = [];
    for (let workerId = 1; workerId <= writers; workerId += 1) {
      jobs.push({ cachePath, mode: "flag-survival", workerId, iterations, bindingKey });
    }
    await runStressChildrenParallel(jobs);
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
    assert.equal(cache.endpoints[bindingKey]?.unsafeReason, "race_double_win");
  });

  it("re-flag while race-unsafe then cas-race alone stays unsafe (blocker A2 repro)", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-a2-seq-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", 100);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey, 200);
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", 300);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey, 400);
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
    assert.equal(cache.endpoints[bindingKey]?.unsafeReason, "race_double_win");
    assert.ok((cache.endpoints[bindingKey]?.unsafeAtMs ?? 0) >= 300);
    assert.notEqual(cache.endpoints[bindingKey]?.doctorSequentialRecheckOk, true);
  });

  it("two healthy backends stay CAS-on across individual rechecks (blocker R1)", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-r1-")), "cache.json");
    const bindingA = "s3:http://loopback:9000:bucket:a";
    const bindingB = "s3:http://loopback:9000:bucket:b";
    const now = Date.now();
    mutateStorageCasCache(cachePath, (cache) => {
      setStorageCasCacheRecord(cache, bindingA, {
        bindingKey: bindingA,
        crossDeviceCas: true,
        probedAtMs: now,
        expiresAtMs: now + 60_000,
      });
      setStorageCasCacheRecord(cache, bindingB, {
        bindingKey: bindingB,
        crossDeviceCas: true,
        probedAtMs: now,
        expiresAtMs: now + 60_000,
      });
    });
    assert.ok(loadSalvagedEndpointsFromLastGood(cachePath));
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingA, now + 1);
    let cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingA]?.crossDeviceCas, true);
    assert.equal(cache.endpoints[bindingB]?.crossDeviceCas, true);
    assert.equal(fs.existsSync(`${cachePath}.corruption-marker`), false);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingB, now + 2);
    cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingA]?.crossDeviceCas, true);
    assert.equal(cache.endpoints[bindingB]?.crossDeviceCas, true);
    assert.equal(fs.existsSync(`${cachePath}.corruption-marker`), false);
  });

  it("new race_double_win after recheck cannot clear with cas-race alone (blocker A2)", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-a2-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", 100);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey, 200);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey, 300);
    let cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, false);

    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", 400);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey, 500);
    cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
    assert.equal(cache.endpoints[bindingKey]?.unsafeReason, "race_double_win");

    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey, 600);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey, 700);
    cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, false);
  });

  it("truncated cache salvages last-good and keeps other backends fail-closed (blocker B)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-corrupt-real-"));
    const cachePath = path.join(dir, "cache.json");
    const bindingA = "s3:http://loopback:9000:bucket:prefix-a";
    const bindingB = "s3:http://loopback:9000:bucket:prefix-b";
    const now = Date.now();
    markStorageCasUnsafePersisted(cachePath, bindingB, "race_double_win", now);
    mutateStorageCasCache(cachePath, (cache) => {
      setStorageCasCacheRecord(cache, bindingA, {
        bindingKey: bindingA,
        crossDeviceCas: true,
        probedAtMs: now,
        expiresAtMs: now + 60_000,
      });
    });
    assert.ok(loadSalvagedEndpointsFromLastGood(cachePath)?.[bindingB]);

    fs.truncateSync(cachePath, 8);
    const corruptView = loadStorageCasCache(cachePath);
    assert.equal(corruptView.fileCorrupt, true);
    assert.equal(corruptView.salvagedEndpoints?.[bindingB]?.unsafeReason, "race_double_win");
    assert.ok(fs.existsSync(`${cachePath}.corruption-marker`));

    recordStorageCasDoctorRecheckSuccess(cachePath, bindingA, now + 1);
    const fixed = loadStorageCasCache(cachePath);
    assert.equal(fixed.endpoints[bindingA]?.crossDeviceCas, true);
    assert.equal(fixed.endpoints[bindingB]?.casUnsafe, true);
    assert.equal(fixed.endpoints[bindingB]?.unsafeReason, "race_double_win");
    const viewB = getStorageCasCacheRecord(fixed, bindingB, now + 1);
    assert.equal(viewB?.unsafe, true);
    assert.equal(viewB?.crossDeviceCas, false);
  });
});
