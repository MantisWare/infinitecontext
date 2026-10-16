import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import {
  attachStorageCasCorruptionContextForRead,
  bumpStorageCasCorruptionMarker,
  DEFAULT_STORAGE_CAS_CACHE_TTL_MS,
  getStorageCasCacheRecord,
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  mergeStorageCasCacheRecords,
  mutateStorageCasCache,
  normalizeStorageCasCacheRecordOnRead,
  readStorageCasCorruptionMarker,
  readStorageCasCorruptionMarkerFile,
  recordStorageCasDoctorRecheckSuccess,
  recordStorageCasDoctorRaceSuccess,
  recordStorageCasInitProbeSuccess,
  saveStorageCasCache,
  setStorageCasCacheRecord,
  setStorageCasClockForTests,
  storageCasCacheLastGoodPath,
  storageCasProbeBindingKey,
  STORAGE_CAS_TIME_SKEW_MS,
  writeStorageCasCorruptionMarkerFile,
} from "../../lib/storage/storage-cas-cache.mjs";
import { normalizeStorageCasEndpoint } from "../../lib/storage/storage-cas-endpoint.mjs";

describe("storage CAS cache", () => {
  afterEach(() => {
    setStorageCasClockForTests(null);
  });

  it("clamps future corruption marker on locked read and rewrites file", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-future-")), "cache.json");
    const now = 2_000_000;
    setStorageCasClockForTests(() => now);
    writeStorageCasCorruptionMarkerFile(cachePath, {
      corruptedAtMs: now + STORAGE_CAS_TIME_SKEW_MS + 60_000,
      salvagedBindings: {},
    });
    saveStorageCasCache({ v: 1, endpoints: {} }, cachePath);
    mutateStorageCasCache(cachePath, () => {});
    const marker = readStorageCasCorruptionMarkerFile(cachePath);
    assert.ok(marker);
    assert.equal(marker?.corruptedAtMs, now);
  });

  it("normalises loopback endpoints to one binding key", () => {
    const a = storageCasProbeBindingKey({ endpoint: "http://127.0.0.1:9000", bucket: "b", prefix: "p" });
    const b = storageCasProbeBindingKey({ endpoint: "http://localhost:9000", bucket: "b", prefix: "p" });
    assert.equal(a, b);
    assert.equal(normalizeStorageCasEndpoint("http://127.0.0.1:9000/"), "http://loopback:9000");
  });

  it("unsafe wins over a concurrent success write", () => {
    const prev = {
      bindingKey: "k",
      crossDeviceCas: false,
      casUnsafe: true,
      unsafeReason: "basic_probe_failed",
      probedAtMs: 1,
      expiresAtMs: 0,
      unsafeAtMs: 1,
    };
    const next = {
      bindingKey: "k",
      crossDeviceCas: true,
      probedAtMs: 2,
      expiresAtMs: 999999,
    };
    const merged = mergeStorageCasCacheRecords(prev, next);
    assert.equal(merged.casUnsafe, true);
    assert.equal(merged.crossDeviceCas, false);
  });

  it("preserves cas_unsafe across locked read-modify-write", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-rmw-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";
    markStorageCasUnsafePersisted(cachePath, bindingKey, "probe_failed", 100);
    mutateStorageCasCache(cachePath, (cache) => {
      setStorageCasCacheRecord(cache, bindingKey, {
        bindingKey,
        crossDeviceCas: true,
        probedAtMs: 200,
        expiresAtMs: Date.now() + 60_000,
      });
    });
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
  });

  it("init probe success never clears race_double_win (blocker A)", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-race-init-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", 100);
    recordStorageCasInitProbeSuccess(cachePath, bindingKey, 200);
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
    assert.equal(cache.endpoints[bindingKey]?.unsafeReason, "race_double_win");
    assert.equal(cache.endpoints[bindingKey]?.crossDeviceCas, false);
  });

  it("race unsafe clears only after doctor recheck and cas-race (blocker A)", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-race-doc-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", 100);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey);
    let cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
    assert.ok((cache.endpoints[bindingKey]?.seqRecheckAtMs ?? 0) > 0);
    assert.equal(cache.endpoints[bindingKey]?.racePassAtMs ?? 0, 0);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey);
    cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, false);
    assert.equal(cache.endpoints[bindingKey]?.crossDeviceCas, true);
  });

  it("corrupt cache recheck keeps other backends fail-closed (blocker B)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-corrupt-b-"));
    const cachePath = path.join(dir, "cache.json");
    const bindingA = "s3:http://loopback:9000:bucket:prefix-a";
    const bindingB = "s3:http://loopback:9000:bucket:prefix-b";
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
        },
      },
      cachePath,
    );
    fs.truncateSync(cachePath, 6);
    const corruptView = loadStorageCasCache(cachePath);
    assert.equal(corruptView.fileCorrupt, true);
    assert.equal(corruptView.salvagedEndpoints?.[bindingB]?.unsafeReason, "race_double_win");
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingA);
    const fixed = loadStorageCasCache(cachePath);
    assert.equal(fixed.endpoints[bindingA]?.crossDeviceCas, true);
    assert.equal(fixed.endpoints[bindingA]?.casUnsafe, false);
    assert.equal(fixed.endpoints[bindingB]?.casUnsafe, true);
    assert.equal(fixed.endpoints[bindingB]?.unsafeReason, "race_double_win");
    fixed.corruptedAtMs = readStorageCasCorruptionMarker(cachePath)?.corruptedAtMs ?? 0;
    const viewB = getStorageCasCacheRecord(fixed, bindingB, now + 1);
    assert.equal(viewB?.unsafe, true);
    assert.equal(viewB?.crossDeviceCas, false);
  });

  it("caps expiry on read when stored expiresAtMs exceeds probe + 24h", () => {
    const record = {
      bindingKey: "expected",
      crossDeviceCas: true,
      probedAtMs: 1000,
      expiresAtMs: 1000 + DEFAULT_STORAGE_CAS_CACHE_TTL_MS + 999_999,
    };
    const normalized = normalizeStorageCasCacheRecordOnRead(record, "expected", 2000);
    assert.equal(normalized.untrusted, true);
    assert.equal(normalized.expiresAtMs, 1000 + DEFAULT_STORAGE_CAS_CACHE_TTL_MS);
    assert.equal(normalized.stale, false);
  });

  it("distrusts bindingKey mismatch on read", () => {
    const record = {
      bindingKey: "wrong",
      crossDeviceCas: true,
      probedAtMs: 1000,
      expiresAtMs: 2000,
    };
    const mismatch = normalizeStorageCasCacheRecordOnRead(record, "expected", 1500);
    assert.equal(mismatch.casUnsafe, true);
    assert.equal(mismatch.unsafeReason, "binding_key_mismatch");
  });

  it("unsalvaged corruption requires seq recheck and cas-race before CAS-on", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-unsalv-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";
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
    fs.unlinkSync(storageCasCacheLastGoodPath(cachePath));
    fs.truncateSync(cachePath, 6);
    bumpStorageCasCorruptionMarker(cachePath);
    let cache = loadStorageCasCache(cachePath);
    attachStorageCasCorruptionContextForRead(cache, cachePath);
    const marker = readStorageCasCorruptionMarkerFile(cachePath);
    assert.deepEqual(marker?.salvagedBindings ?? {}, {});
    assert.equal(cache.salvageUnavailable, true);
    assert.equal(getStorageCasCacheRecord(cache, bindingKey, now)?.crossDeviceCas, false);
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey);
    cache = loadStorageCasCache(cachePath);
    attachStorageCasCorruptionContextForRead(cache, cachePath);
    assert.equal(getStorageCasCacheRecord(cache, bindingKey, now)?.crossDeviceCas, false);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey);
    cache = loadStorageCasCache(cachePath);
    attachStorageCasCorruptionContextForRead(cache, cachePath);
    assert.equal(getStorageCasCacheRecord(cache, bindingKey, now)?.crossDeviceCas, true);
  });

  it("fail closed on corrupt cache until recheck clears it", () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-bad-")), "cache.json");
    fs.writeFileSync(cachePath, "{ not-json", { mode: 0o600 });
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.fileCorrupt, true);
    assert.ok(fs.readdirSync(path.dirname(cachePath)).some((n) => n.includes(".corrupt.")));
    mutateStorageCasCache(cachePath, (c) => {
      c.endpoints["s3:x:b:"] = {
        bindingKey: "s3:x:b:",
        crossDeviceCas: true,
        probedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      };
    });
    const fixed = loadStorageCasCache(cachePath);
    assert.equal(fixed.fileCorrupt, false);
    assert.equal(fixed.endpoints["s3:x:b:"]?.crossDeviceCas, true);
  });
});
