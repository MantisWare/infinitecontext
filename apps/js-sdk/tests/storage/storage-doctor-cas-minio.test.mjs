import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  attachStorageCasCorruptionContextForRead,
  getStorageCasCacheRecord,
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  readStorageCasCorruptionMarker,
  storageCasCacheFilePath,
  storageCasCacheLastGoodPath,
  storageCasProbeBindingKey,
} from "../../lib/storage/storage-cas-cache.mjs";
import {
  runStorageDoctorCasRace,
  runStorageDoctorRecheckCas,
  runStorageDoctorResetCasCache,
} from "../../lib/storage/storage-doctor-cas.mjs";
import { createS3StorageAdapter } from "../../lib/storage/s3-adapter.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";

/**
 * @returns {{ bucket: string, prefix: string, region: string, endpoint?: string } | null}
 */
function resolveS3AdapterTestConfigFromEnv(env = process.env) {
  const bucket = String(env.INFINITECONTEXT_S3_TEST_BUCKET ?? "").trim();
  const endpoint = String(env.AWS_ENDPOINT_URL ?? env.INFINITECONTEXT_S3_ENDPOINT ?? "").trim();
  if (!bucket || !endpoint) {
    return null;
  }
  return {
    bucket,
    prefix: String(env.INFINITECONTEXT_S3_TEST_PREFIX ?? "ic-s3-test").replace(/\/+$/, ""),
    region: String(env.AWS_REGION ?? "us-east-1"),
    endpoint,
  };
}

/**
 * @param {(homeDir: string) => Promise<void>} fn
 */
async function withIsolatedInfinitecontextHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  fs.mkdirSync(path.join(homeDir, ".infinitecontext"), { recursive: true, mode: 0o700 });
  try {
    await fn(homeDir);
  } finally {
    process.env.HOME = prevHome;
  }
}

const s3Config = resolveS3AdapterTestConfigFromEnv(process.env);
const requireMinio = process.env.IC_REQUIRE_MINIO === "1";

(s3Config ? describe : describe.skip)("storage doctor CAS (MinIO / CI)", () => {
  it("doctor --recheck-cas clears cas_unsafe on a healthy backend", async () => {
    assert.ok(s3Config);
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-recheck-")), "cache.json");
    const config = {
      storage: {
        backend: "s3",
        s3: {
          bucket: s3Config.bucket,
          prefix: `${s3Config.prefix}/doctor-recheck-${Date.now()}`,
          region: s3Config.region,
          endpoint: s3Config.endpoint,
        },
      },
    };
    const bindingKey = storageCasProbeBindingKey({
      endpoint: s3Config.endpoint,
      bucket: s3Config.bucket,
      prefix: config.storage.s3.prefix,
    });
    markStorageCasUnsafePersisted(cachePath, bindingKey, "test_sticky", Date.now());
    const result = await runStorageDoctorRecheckCas({ config, env: process.env, cachePath });
    assert.equal(result.ok, true);
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, false);
    assert.equal(cache.endpoints[bindingKey]?.crossDeviceCas, true);
  });

  it("doctor --cas-race on a never-probed backend does not persist cas_unsafe", async () => {
    assert.ok(s3Config);
    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-doc-race-")), "cache.json");
    const config = {
      storage: {
        backend: "s3",
        s3: {
          bucket: s3Config.bucket,
          prefix: `${s3Config.prefix}/doctor-race-${Date.now()}`,
          region: s3Config.region,
          endpoint: s3Config.endpoint,
        },
      },
    };
    const bindingKey = storageCasProbeBindingKey({
      endpoint: s3Config.endpoint,
      bucket: s3Config.bucket,
      prefix: config.storage.s3.prefix,
    });
    const result = await runStorageDoctorCasRace({
      config,
      env: process.env,
      cachePath,
      rounds: 20,
    });
    console.log(`IC_DOCTOR_CAS_RACE: ok=${result.ok} inconclusive=${result.inconclusive} persisted=${result.persistedUnsafe}`);
    assert.equal(result.ok, true);
    assert.equal(result.persistedUnsafe, false);
    const cache = loadStorageCasCache(cachePath);
    assert.equal(cache.endpoints[bindingKey]?.casUnsafe, undefined);
  });

  it("default cachePath: corrupt cache keeps unrechecked init fail-closed (C1)", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async () => {
      const defaultCachePath = storageCasCacheFilePath();
      const prefixA = `${s3Config.prefix}/cas-default-a-${Date.now()}`;
      const prefixB = `${s3Config.prefix}/cas-default-b-${Date.now()}`;
      const bindingA = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix: prefixA,
      });
      const bindingB = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix: prefixB,
      });

      const adapterA = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixA,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      });
      await adapterA.init();
      assert.equal(adapterA.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
      await adapterA.close();

      markStorageCasUnsafePersisted(undefined, bindingB, "race_double_win", Date.now());
      assert.ok(fs.existsSync(storageCasCacheLastGoodPath(defaultCachePath)));
      fs.unlinkSync(storageCasCacheLastGoodPath(defaultCachePath));
      fs.truncateSync(defaultCachePath, 8);

      let probeCalls = 0;
      const adapterB = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixB,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        casProbe: async () => {
          probeCalls += 1;
          return true;
        },
      });
      await adapterB.init();
      assert.equal(probeCalls, 0);
      assert.equal(adapterB.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), false);
      await adapterB.close();

      const configA = {
        storage: {
          backend: "s3",
          s3: {
            bucket: s3Config.bucket,
            prefix: prefixA,
            region: s3Config.region,
            endpoint: s3Config.endpoint,
          },
        },
      };
      await runStorageDoctorRecheckCas({ config: configA, env: process.env });

      const adapterA2 = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixA,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        casProbe: async () => {
          throw new Error("probe should not run after doctor recheck");
        },
      });
      await adapterA2.init();
      assert.equal(adapterA2.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
      await adapterA2.close();

      const cache = loadStorageCasCache(defaultCachePath);
      attachStorageCasCorruptionContextForRead(cache, defaultCachePath);
      const corruptedAtMs = readStorageCasCorruptionMarker(defaultCachePath)?.corruptedAtMs ?? 0;
      assert.ok(corruptedAtMs > 0);
      const viewB = getStorageCasCacheRecord(cache, bindingB, Date.now());
      assert.equal(viewB?.crossDeviceCas, false);
      assert.equal(viewB?.unsafe, true);
      assert.equal(cache.endpoints[bindingA]?.crossDeviceCas, true);
    });
  });

  it("default cachePath: doctor recheck after corruption without last-good (real paths)", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async () => {
      const defaultCachePath = storageCasCacheFilePath();
      const prefixA = `${s3Config.prefix}/cas-nolg-a-${Date.now()}`;
      const prefixC = `${s3Config.prefix}/cas-nolg-c-${Date.now()}`;
      const bindingA = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix: prefixA,
      });
      const bindingC = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix: prefixC,
      });

      for (const prefix of [prefixA, prefixC]) {
        const adapter = createS3StorageAdapter({
          bucket: s3Config.bucket,
          prefix,
          region: s3Config.region,
          endpoint: s3Config.endpoint,
        });
        await adapter.init();
        await adapter.close();
      }

      fs.unlinkSync(storageCasCacheLastGoodPath(defaultCachePath));
      fs.truncateSync(defaultCachePath, 8);

      const configA = {
        storage: {
          backend: "s3",
          s3: {
            bucket: s3Config.bucket,
            prefix: prefixA,
            region: s3Config.region,
            endpoint: s3Config.endpoint,
          },
        },
      };
      await runStorageDoctorRecheckCas({ config: configA, env: process.env });

      const cache = loadStorageCasCache(defaultCachePath);
      attachStorageCasCorruptionContextForRead(cache, defaultCachePath);
      const viewC = getStorageCasCacheRecord(cache, bindingC, Date.now());
      assert.equal(cache.endpoints[bindingA]?.crossDeviceCas, true);
      assert.equal(viewC?.crossDeviceCas, false);
      assert.equal(viewC?.unsafe, true);
    });
  });

  it("--reset-cas-cache bumps marker and preserves race unsafe flags (C3)", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async () => {
      const defaultCachePath = storageCasCacheFilePath();
      const prefix = `${s3Config.prefix}/cas-reset-${Date.now()}`;
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      markStorageCasUnsafePersisted(undefined, bindingKey, "race_double_win", Date.now());
      const beforeMarker = readStorageCasCorruptionMarker(defaultCachePath)?.corruptedAtMs ?? 0;

      runStorageDoctorResetCasCache({});

      const afterMarker = readStorageCasCorruptionMarker(defaultCachePath)?.corruptedAtMs ?? 0;
      assert.ok(afterMarker >= beforeMarker);
      assert.ok(afterMarker > 0);
      const cache = loadStorageCasCache(defaultCachePath);
      assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
      assert.equal(cache.endpoints[bindingKey]?.flagKind, "race_double_win");
      assert.equal(cache.endpoints[bindingKey]?.seqRecheckAtMs ?? 0, 0);
      assert.equal(cache.endpoints[bindingKey]?.racePassAtMs ?? 0, 0);
      assert.equal(fs.existsSync(storageCasCacheLastGoodPath(defaultCachePath)), false);
    });
  });
});

if (requireMinio && !s3Config) {
  throw new Error("IC_REQUIRE_MINIO=1 but S3 test config is missing");
}
