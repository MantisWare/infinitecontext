import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  mergeStorageCasCacheRecords,
  mutateStorageCasCache,
  setStorageCasCacheRecord,
  storageCasProbeBindingKey,
} from "../../lib/storage/storage-cas-cache.mjs";
import { normalizeStorageCasEndpoint } from "../../lib/storage/storage-cas-endpoint.mjs";

describe("storage CAS cache", () => {
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
