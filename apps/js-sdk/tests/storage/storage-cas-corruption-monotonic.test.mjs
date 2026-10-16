import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  bumpStorageCasCorruptionMarker,
  getStorageCasCacheRecord,
  isBindingCasTrustedAfterCorruption,
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  mergeSalvagedUnsafeOnce,
  mutateStorageCasCache,
  readStorageCasCorruptionMarker,
  recordStorageCasDoctorRaceSuccess,
  recordStorageCasDoctorRecheckSuccess,
  saveStorageCasCache,
  setStorageCasCacheRecord,
  storageCasCacheLastGoodPath,
} from "../../lib/storage/storage-cas-cache.mjs";
import { resolveCrossDeviceCasForAdapterInit } from "../../lib/storage/storage-cas-init.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";

describe("storage CAS corruption monotonic recovery (blocker B)", () => {
  it("no last-good: truncate, recheck A, B/C fail-closed, B race preserved from one-time salvage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-b1-"));
    const cachePath = path.join(dir, "cache.json");
    const bindingA = "s3:loopback:9000:b:a";
    const bindingB = "s3:loopback:9000:b:b";
    const bindingC = "s3:loopback:9000:b:c";
    const now = Date.now();
    saveStorageCasCache(
      {
        v: 1,
        endpoints: {
          [bindingA]: {
            bindingKey: bindingA,
            crossDeviceCas: true,
            probedAtMs: now,
            expiresAtMs: now + 60_000,
          },
          [bindingB]: {
            bindingKey: bindingB,
            crossDeviceCas: false,
            casUnsafe: true,
            unsafeReason: "race_double_win",
            probedAtMs: now,
            expiresAtMs: 0,
          },
          [bindingC]: {
            bindingKey: bindingC,
            crossDeviceCas: true,
            probedAtMs: now,
            expiresAtMs: now + 60_000,
          },
        },
      },
      cachePath,
    );
    const salvagedSnapshot = JSON.parse(fs.readFileSync(cachePath, "utf8")).endpoints;
    fs.unlinkSync(storageCasCacheLastGoodPath(cachePath));
    fs.truncateSync(cachePath, 8);
    const corruptedAtMs = bumpStorageCasCorruptionMarker(cachePath);
    mutateStorageCasCache(cachePath, (cache) => {
      mergeSalvagedUnsafeOnce(cache.endpoints, salvagedSnapshot, corruptedAtMs);
      cache.salvageMergedForCorruptedAtMs = corruptedAtMs;
    });
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingA);
    const cache = loadStorageCasCache(cachePath);
    cache.corruptedAtMs = readStorageCasCorruptionMarker(cachePath)?.corruptedAtMs ?? corruptedAtMs;
    assert.ok(readStorageCasCorruptionMarker(cachePath));
    assert.equal(isBindingCasTrustedAfterCorruption(cache.endpoints[bindingA], cache.corruptedAtMs), true);
    const viewB = getStorageCasCacheRecord(cache, bindingB, now + 11);
    const viewC = getStorageCasCacheRecord(cache, bindingC, now + 11);
    assert.equal(viewB?.crossDeviceCas, false);
    assert.equal(viewB?.unsafeReason, "race_double_win");
    assert.equal(viewC?.crossDeviceCas, false);
    assert.equal(viewC?.unsafe, true);
  });

  it("last-good present: recheck A then C then B, all CAS-on, none re-disabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-b2-"));
    const cachePath = path.join(dir, "cache.json");
    const bindingA = "s3:loopback:9000:b:a2";
    const bindingB = "s3:loopback:9000:b:b2";
    const bindingC = "s3:loopback:9000:b:c2";
    const now = Date.now();
    saveStorageCasCache(
      {
        v: 1,
        endpoints: {
          [bindingA]: {
            bindingKey: bindingA,
            crossDeviceCas: true,
            probedAtMs: now,
            expiresAtMs: now + 60_000,
          },
          [bindingB]: {
            bindingKey: bindingB,
            crossDeviceCas: true,
            probedAtMs: now,
            expiresAtMs: now + 60_000,
          },
          [bindingC]: {
            bindingKey: bindingC,
            crossDeviceCas: true,
            probedAtMs: now,
            expiresAtMs: now + 60_000,
          },
        },
      },
      cachePath,
    );
    fs.truncateSync(cachePath, 8);
    bumpStorageCasCorruptionMarker(cachePath);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingA);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingC);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingB);
    const cache = loadStorageCasCache(cachePath);
    cache.corruptedAtMs = readStorageCasCorruptionMarker(cachePath)?.corruptedAtMs ?? 0;
    for (const key of [bindingA, bindingB, bindingC]) {
      assert.equal(isBindingCasTrustedAfterCorruption(cache.endpoints[key], cache.corruptedAtMs), true);
      assert.equal(getStorageCasCacheRecord(cache, key, now + 41)?.crossDeviceCas, true);
    }
    assert.ok(readStorageCasCorruptionMarker(cachePath));
  });

  it("repeated init after all rechecked stays CAS-on", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-b3-")), "cache.json");
    const bindingKey = "s3:mem:bucket:ok";
    const now = Date.now();
    saveStorageCasCache(
      {
        v: 1,
        endpoints: {
          [bindingKey]: {
            bindingKey,
            crossDeviceCas: true,
            probedAtMs: now,
            expiresAtMs: now + 60_000,
          },
        },
      },
      cachePath,
    );
    fs.truncateSync(cachePath, 6);
    bumpStorageCasCorruptionMarker(cachePath);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey);
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    for (let i = 0; i < 5; i += 1) {
      const resolved = await resolveCrossDeviceCasForAdapterInit(adapter, {
        bindingKey,
        mode: "read-write",
        cachePath,
        runBasicProbe: async () => {
          throw new Error("probe should not run");
        },
      });
      assert.equal(resolved.crossDeviceCas, true);
      assert.equal(resolved.source, "cache");
    }
    await adapter.close();
  });
});
