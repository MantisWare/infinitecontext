import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  attachStorageCasCorruptionContextForRead,
  getStorageCasCacheRecord,
  loadStorageCasCache,
  readStorageCasCorruptionMarkerFile,
  storageCasCacheFilePath,
  storageCasCacheLastGoodPath,
  storageCasProbeBindingKey,
} from "../../lib/storage/storage-cas-cache.mjs";
import { createS3StorageAdapter } from "../../lib/storage/s3-adapter.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntry = path.join(repoRoot, "src/cli/entry.mjs");
const raceDoubleWinPreload = path.join(repoRoot, "tests/storage/preload-s3-cas-race-double-win.mjs");

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
 * @param {Record<string, string>} [envPatch]
 * @param {string[]} doctorArgs
 */
function spawnStorageDoctorCli(homeDir, envPatch, doctorArgs, options = {}) {
  const env = { ...process.env, ...envPatch, HOME: homeDir };
  if (options.casRaceDoubleWin) {
    env.NODE_OPTIONS = `--import=${raceDoubleWinPreload}`;
    env.NODE_ENV = env.NODE_ENV ?? "test";
  }
  const res = spawnSync(process.execPath, [cliEntry, "storage", "doctor", ...doctorArgs], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr || res.stdout || `exit ${res.status}`);
  const text = String(res.stdout).trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  assert.ok(first >= 0 && last > first, `CLI stdout missing JSON object: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(first, last + 1));
}

/**
 * @param {(homeDir: string) => Promise<void>} fn
 */
async function withIsolatedInfinitecontextHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-home-"));
  await fn(homeDir);
}

const s3Config = resolveS3AdapterTestConfigFromEnv(process.env);
const requireMinio = process.env.IC_REQUIRE_MINIO === "1";

if (requireMinio && !s3Config) {
  throw new Error(
    "IC_REQUIRE_MINIO=1 but MinIO/S3 endpoint is unreachable (set AWS_ENDPOINT_URL and INFINITECONTEXT_S3_TEST_BUCKET)",
  );
}

(s3Config ? describe : describe.skip)("storage doctor CAS CLI (MinIO / CI)", () => {
  it("CLI doctor --recheck-cas clears cas_unsafe on a healthy backend", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-recheck-${Date.now()}`;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      const adapter = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      });
      await adapter.init();
      await adapter.close();
      const result = spawnStorageDoctorCli(homeDir, {}, ["--recheck-cas"]);
      assert.equal(result.ok, true);
      assert.equal(result.crossDeviceCas, true);
      const cache = loadStorageCasCache(storageCasCacheFilePath());
      assert.equal(cache.endpoints[bindingKey]?.crossDeviceCas, true);
    });
  });

  it("CLI doctor --cas-race on a never-probed backend does not persist cas_unsafe", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-race-${Date.now()}`;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      const result = spawnStorageDoctorCli(homeDir, {}, ["--cas-race=20"]);
      console.log(
        `IC_DOCTOR_CAS_RACE: ok=${result.ok} inconclusive=${result.inconclusive} persisted=${result.persistedUnsafe}`,
      );
      assert.equal(result.ok, true);
      assert.equal(result.persistedUnsafe, false);
      const cache = loadStorageCasCache(storageCasCacheFilePath());
      assert.notEqual(cache.endpoints[bindingKey]?.casUnsafe, true);
    });
  });

  it("CLI doctor --reset-cas-cache bumps marker and preserves race unsafe flags", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-reset-${Date.now()}`;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      spawnStorageDoctorCli(homeDir, {}, ["--cas-race=5"], { casRaceDoubleWin: true });
      const defaultCachePath = storageCasCacheFilePath();
      const beforeMarker = readStorageCasCorruptionMarkerFile(defaultCachePath)?.corruptedAtMs ?? 0;

      const result = spawnStorageDoctorCli(homeDir, {}, ["--reset-cas-cache"]);
      assert.equal(result.ok, true);

      const marker = readStorageCasCorruptionMarkerFile(defaultCachePath);
      assert.ok((marker?.corruptedAtMs ?? 0) >= beforeMarker);
      assert.equal(marker?.salvagedBindings?.[bindingKey]?.flagKind, "race_double_win");
      const cache = loadStorageCasCache(defaultCachePath);
      assert.equal(cache.endpoints[bindingKey]?.casUnsafe, true);
      assert.equal(fs.existsSync(storageCasCacheLastGoodPath(defaultCachePath)), false);
    });
  });

  it("salvaged race-flagged backend: two CLI rechecks without cas-race stay fail-closed (P1)", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefix = `${s3Config.prefix}/cli-p1-${Date.now()}`;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefix);
      const bindingKey = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix,
      });
      const defaultCachePath = storageCasCacheFilePath();

      const adapter = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      });
      await adapter.init();
      await adapter.close();

      const race = spawnStorageDoctorCli(homeDir, {}, ["--cas-race=5"], { casRaceDoubleWin: true });
      assert.equal(race.persistedUnsafe, true);

      assert.ok(fs.existsSync(storageCasCacheLastGoodPath(defaultCachePath)));
      fs.truncateSync(defaultCachePath, 8);
      loadStorageCasCache(defaultCachePath);

      const marker = readStorageCasCorruptionMarkerFile(defaultCachePath);
      assert.equal(marker?.salvagedBindings?.[bindingKey]?.flagKind, "race_double_win");

      writeS3ConfigInHome(homeDir, prefix);
      const first = spawnStorageDoctorCli(homeDir, {}, ["--recheck-cas"]);
      assert.equal(first.ok, true);
      assert.equal(first.crossDeviceCas, false);
      const second = spawnStorageDoctorCli(homeDir, {}, ["--recheck-cas"]);
      assert.equal(second.ok, true);
      assert.equal(second.crossDeviceCas, false);

      const adapter2 = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        casProbe: async () => {
          throw new Error("init probe must not run while race recovery pending");
        },
      });
      await adapter2.init();
      assert.equal(adapter2.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), false);
      await adapter2.close();
    });
  });

  it("corruption without last-good: CLI recheck + cas-race restores CAS", async () => {
    assert.ok(s3Config);
    await withIsolatedInfinitecontextHome(async (homeDir) => {
      const prefixA = `${s3Config.prefix}/cli-nolg-a-${Date.now()}`;
      const prefixB = `${s3Config.prefix}/cli-nolg-b-${Date.now()}`;
      process.env.HOME = homeDir;
      writeS3ConfigInHome(homeDir, prefixA);
      const bindingB = storageCasProbeBindingKey({
        endpoint: s3Config.endpoint,
        bucket: s3Config.bucket,
        prefix: prefixB,
      });
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

      fs.unlinkSync(storageCasCacheLastGoodPath(defaultCachePath));
      fs.truncateSync(defaultCachePath, 8);
      loadStorageCasCache(defaultCachePath);

      spawnStorageDoctorCli(homeDir, {}, ["--recheck-cas"]);
      writeS3ConfigInHome(homeDir, prefixB);
      spawnStorageDoctorCli(homeDir, {}, ["--recheck-cas"]);
      spawnStorageDoctorCli(homeDir, {}, ["--cas-race=20"]);

      const adapterB = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: prefixB,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        casProbe: async () => {
          throw new Error("probe should not run after doctor recovery");
        },
      });
      await adapterB.init();
      assert.equal(adapterB.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
      await adapterB.close();

      const cache = loadStorageCasCache(defaultCachePath);
      attachStorageCasCorruptionContextForRead(cache, defaultCachePath);
      assert.equal(getStorageCasCacheRecord(cache, bindingB, Date.now())?.crossDeviceCas, true);
    });
  });
});

if (requireMinio && !s3Config) {
  throw new Error("IC_REQUIRE_MINIO=1 but S3 test config is missing");
}
