import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import {
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  storageCasProbeBindingKey,
} from "../../lib/storage/storage-cas-cache.mjs";
import {
  recheckStorageCasProbe,
  resolveCrossDeviceCasForAdapterInit,
} from "../../lib/storage/storage-cas-init.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";
import { createS3StorageAdapter } from "../../lib/storage/s3-adapter.mjs";

describe("storage CAS init cache", () => {
  it("read-only init does not run the basic probe", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-cache-")), "cache.json");
    const bindingKey = "s3:test:bucket:prefix";
    let probeCalls = 0;
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const resolved = await resolveCrossDeviceCasForAdapterInit(adapter, {
      bindingKey,
      mode: "read-only",
      cachePath,
      runBasicProbe: async () => {
        probeCalls += 1;
        return true;
      },
    });
    assert.equal(probeCalls, 0);
    assert.equal(resolved.crossDeviceCas, null);
    assert.equal(resolved.source, "unknown");
    await adapter.close();
  });

  it("init probe success does not clear race_double_win unsafe", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-race-init2-")), "cache.json");
    const bindingKey = "s3:mem:bucket:race";
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", Date.now());
    const resolved = await resolveCrossDeviceCasForAdapterInit(adapter, {
      bindingKey,
      mode: "read-write",
      cachePath,
      runBasicProbe: async () => true,
    });
    assert.equal(resolved.crossDeviceCas, false);
    assert.equal(resolved.source, "cas_unsafe");
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
    assert.equal(cache.endpoints[bindingKey]?.unsafeReason, "race_double_win");
    await adapter.close();
  });

  it("keeps crossDeviceCas off after a failed probe until recheck-cas passes", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-cache-")), "cache.json");
    const bindingKey = "s3:mem:bucket:p";
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    let probeCalls = 0;
    const failOnceProbe = async () => {
      probeCalls += 1;
      return probeCalls > 1;
    };
    const first = await resolveCrossDeviceCasForAdapterInit(adapter, {
      bindingKey,
      mode: "read-write",
      cachePath,
      runBasicProbe: failOnceProbe,
    });
    assert.equal(first.crossDeviceCas, false);
    assert.equal(first.source, "probe_failed");
    const cacheAfterFail = loadStorageCasCache(cachePath);
    assert.equal(cacheAfterFail.endpoints[bindingKey]?.casUnsafe, true);

    const second = await resolveCrossDeviceCasForAdapterInit(adapter, {
      bindingKey,
      mode: "read-write",
      cachePath,
      runBasicProbe: async () => true,
    });
    assert.equal(second.crossDeviceCas, false);
    assert.equal(second.source, "cas_unsafe");
    assert.equal(probeCalls, 1);

    const recheck = await recheckStorageCasProbe(adapter, {
      bindingKey,
      cachePath,
      runBasicProbe: async () => true,
    });
    assert.equal(recheck.ok, true);
    const third = await resolveCrossDeviceCasForAdapterInit(adapter, {
      bindingKey,
      mode: "read-write",
      cachePath,
      runBasicProbe: async () => true,
    });
    assert.equal(third.crossDeviceCas, true);
    assert.equal(third.source, "cache");
    await adapter.close();
  });

  it("S3 adapter init uses cache on second read-write open within TTL", async () => {
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-cache-")), "cache.json");
    let probeCalls = 0;
    const runBasicProbe = async () => {
      probeCalls += 1;
      return true;
    };
    const mk = () =>
      createS3StorageAdapter({
        bucket: "b",
        prefix: "p",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9",
        client: /** @type {any} */ ({
          send: async (cmd) => {
            const name = cmd.constructor?.name ?? "";
            if (name === "HeadBucketCommand") return {};
            if (name === "ListObjectsV2Command") return { Contents: [], IsTruncated: false };
            if (name === "DeleteObjectCommand") return {};
            throw new Error(`unexpected ${name}`);
          },
          destroy: () => {},
        }),
        casProbe: runBasicProbe,
      });

    const adapterA = mk();
    await adapterA.init({ mode: "read-write", cachePath, sweepProbeKeys: false });
    assert.equal(probeCalls, 1);
    assert.equal(adapterA.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
    await adapterA.close();

    const adapterB = mk();
    await adapterB.init({ mode: "read-write", cachePath, sweepProbeKeys: false });
    assert.equal(probeCalls, 1);
    assert.equal(adapterB.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
    await adapterB.close();
  });
});

describe("storageCasProbeBindingKey", () => {
  it("normalizes endpoint and prefix", () => {
    const key = storageCasProbeBindingKey({ endpoint: "http://127.0.0.1:9000/", bucket: "b", prefix: "/p/" });
    assert.equal(key, "s3:http://loopback:9000:b:p");
    assert.equal(
      storageCasProbeBindingKey({ endpoint: "http://localhost:9000", bucket: "b", prefix: "p" }),
      key,
    );
  });
});
