import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadStorageCasCache,
  markStorageCasUnsafePersisted,
  storageCasProbeBindingKey,
} from "../../lib/storage/storage-cas-cache.mjs";
import {
  runStorageDoctorCasRace,
  runStorageDoctorRecheckCas,
} from "../../lib/storage/storage-doctor-cas.mjs";

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
});

if (requireMinio && !s3Config) {
  throw new Error("IC_REQUIRE_MINIO=1 but S3 test config is missing");
}
