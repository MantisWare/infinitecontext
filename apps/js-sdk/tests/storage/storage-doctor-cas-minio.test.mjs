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
 * @param {string} homeDir
 * @param {string} prefix
 */
function writeS3ConfigInHome(homeDir, prefix) {
  assert.ok(s3Config);
  const config = {
    storage: {
      backend: "s3",
      s3: {
        bucket: s3Config.bucket,
        prefix,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      },
    },
  };
  const dir = path.join(homeDir, ".infinitecontext");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

/**
 * @param {string} homeDir
 * @param {string[]} doctorArgs
 */
async function runStorageDoctorCli(homeDir, doctorArgs) {
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  /** @type {string[]} */
  const lines = [];
  const origLog = console.log;
  console.log = (msg) => {
    lines.push(String(msg));
    origLog(msg);
  };
  try {
    const { runStorageCli } = await import("../../src/cli/storage-cli.mjs");
    await runStorageCli("doctor", doctorArgs);
    const last = lines.filter((line) => line.trim()).pop();
    assert.ok(last, "expected JSON on stdout from storage doctor CLI");
    return JSON.parse(last);
  } finally {
    console.log = origLog;
    process.env.HOME = prevHome;
  }
}

/**
 * @param {(homeDir: string) => Promise<void>} fn
 */
async function withIsolatedInfinitecontextHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-home-"));
  try {
    await fn(homeDir);
  } finally {
    /* home is ephemeral */
  }
}

const s3Config = resolveS3AdapterTestConfigFromEnv(process.env);
const requireMinio = process.env.IC_REQUIRE_MINIO === "1";

(s3Config ? describe : describe.skip)("storage doctor CAS CLI (MinIO / CI)", () => {
  it("CLI doctor --recheck-cas clears cas_unsafe on a healthy backend", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-recheck-${Date.now()}`;
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      markStorageCasUnsafePersisted(undefined, bindingKey, "test_sticky", Date.now());
      const result = await runStorageDoctorCli(homeDir, ["--recheck-cas"]);
      assert.equal(result.ok, true);
      const cache = loadStorageCasCache(storageCasCacheFilePath());
      assert.equal(cache.endpoints[bindingKey]?.casUnsafe, false);
      assert.equal(cache.endpoints[bindingKey]?.crossDeviceCas, true);
      process.env.HOME = prevHome;
    });
  });

  it("CLI doctor --cas-race on a never-probed backend does not persist cas_unsafe", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-race-${Date.now()}`;
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      const result = await runStorageDoctorCli(homeDir, ["--cas-race=20"]);
      console.log(
        `IC_DOCTOR_CAS_RACE: ok=${result.ok} inconclusive=${result.inconclusive} persisted=${result.persistedUnsafe}`,
      );
      assert.equal(result.ok, true);
      assert.equal(result.persistedUnsafe, false);
      const cache = loadStorageCasCache(storageCasCacheFilePath());
      assert.notEqual(cache.endpoints[bindingKey]?.casUnsafe, true);
      process.env.HOME = prevHome;
    });
  });

  it("CLI doctor --reset-cas-cache bumps marker and preserves race unsafe flags", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-reset-${Date.now()}`;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      markStorageCasUnsafePersisted(undefined, bindingKey, "race_double_win", Date.now());
      const defaultCachePath = storageCasCacheFilePath();
      const beforeMarker = readStorageCasCorruptionMarker(defaultCachePath)?.corruptedAtMs ?? 0;

      const result = await runStorageDoctorCli(homeDir, ["--reset-cas-cache"]);
      assert.equal(result.ok, true);

      const afterMarker = readStorageCasCorruptionMarker(defaultCachePath)?.corruptedAtMs ?? 0;
      assert.ok(afterMarker >= beforeMarker);
      assert.ok(afterMarker > 0);
      const cache = loadStorageCasCache(defaultCachePath);
      assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
      assert.equal(cache.endpoints[bindingKey]?.flagKind, "race_double_win");
      assert.equal(cache.endpoints[bindingKey]?.seqRecheckAtMs ?? 0, 0);
      assert.equal(cache.endpoints[bindingKey]?.racePassAtMs ?? 0, 0);
      assert.equal(fs.existsSync(storageCasCacheLastGoodPath(defaultCachePath)), false);
      process.env.HOME = prevHome;
    });
  });

  it("corruption without last-good: race flag lost; CLI recheck + cas-race restores CAS", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefixA = `${s3Config.prefix}/cli-nolg-a-${Date.now()}`;
      const prefixB = `${s3Config.prefix}/cli-nolg-b-${Date.now()}`;
      writeS3ConfigInHome(homeDir, prefixA);
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

      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      const defaultCachePath = storageCasCacheFilePath();

      for (const prefix of [prefixA, prefixB]) {
        const adapter = createS3StorageAdapter({
          bucket: s3Config.bucket,
          prefix,
          region: s3Config.region,
          endpoint: s3Config.endpoint,
        });
        await adapter.init();
        await adapter.close();
      }

      markStorageCasUnsafePersisted(undefined, bindingB, "race_double_win", Date.now());
      assert.ok(fs.existsSync(storageCasCacheLastGoodPath(defaultCachePath)));
      fs.unlinkSync(storageCasCacheLastGoodPath(defaultCachePath));
      fs.truncateSync(defaultCachePath, 8);

      let cache = loadStorageCasCache(defaultCachePath);
      attachStorageCasCorruptionContextForRead(cache, defaultCachePath);
      assert.equal(cache.salvageUnavailable, true);
      assert.equal(cache.endpoints[bindingB], undefined);
      assert.equal(getStorageCasCacheRecord(cache, bindingB, Date.now())?.unsafe, true);

      await runStorageDoctorCli(homeDir, ["--recheck-cas"]);
      cache = loadStorageCasCache(defaultCachePath);
      attachStorageCasCorruptionContextForRead(cache, defaultCachePath);
      assert.equal(getStorageCasCacheRecord(cache, bindingA, Date.now())?.crossDeviceCas, false);

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

      writeS3ConfigInHome(homeDir, prefixB);
      await runStorageDoctorCli(homeDir, ["--recheck-cas"]);
      await runStorageDoctorCli(homeDir, ["--cas-race=20"]);

      const adapterB2 = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixB,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        casProbe: async () => {
          throw new Error("probe should not run after doctor recovery");
        },
      });
      await adapterB2.init();
      assert.equal(adapterB2.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
      await adapterB2.close();

      writeS3ConfigInHome(homeDir, prefixA);
      await runStorageDoctorCli(homeDir, ["--recheck-cas"]);
      await runStorageDoctorCli(homeDir, ["--cas-race=20"]);
      const adapterA = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixA,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        casProbe: async () => {
          throw new Error("probe should not run after doctor recovery");
        },
      });
      await adapterA.init();
      assert.equal(adapterA.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
      await adapterA.close();

      process.env.HOME = prevHome;
    });
  });

  it("default cachePath: corrupt cache keeps unrechecked init fail-closed", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefixA = `${s3Config.prefix}/cas-default-a-${Date.now()}`;
      const prefixB = `${s3Config.prefix}/cas-default-b-${Date.now()}`;
      writeS3ConfigInHome(homeDir, prefixA);
      const bindingB = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix: prefixB,
      });

      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      const defaultCachePath = storageCasCacheFilePath();

      const adapterA = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixA,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      });
      await adapterA.init();
      await adapterA.close();

      markStorageCasUnsafePersisted(undefined, bindingB, "race_double_win", Date.now());
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

      await runStorageDoctorCli(homeDir, ["--recheck-cas"]);
      await runStorageDoctorCli(homeDir, ["--cas-race=20"]);

      const cache = loadStorageCasCache(defaultCachePath);
      attachStorageCasCorruptionContextForRead(cache, defaultCachePath);
      const viewB = getStorageCasCacheRecord(cache, bindingB, Date.now());
      assert.equal(viewB?.crossDeviceCas, false);
      assert.equal(viewB?.unsafe, true);

      process.env.HOME = prevHome;
    });
  });
});

if (requireMinio && !s3Config) {
  throw new Error("IC_REQUIRE_MINIO=1 but S3 test config is missing");
}
