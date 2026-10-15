import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeCrossDeviceCasConcurrency } from "../../lib/storage/storage-cas-concurrency-probe.mjs";
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
  };
}

const s3Config = resolveS3AdapterTestConfigFromEnv(process.env);
const requireMinio = process.env.IC_REQUIRE_MINIO === "1";

(s3Config ? describe : describe.skip)("S3 CAS concurrency probe (CI)", () => {
  it("parallel If-None-Match:* creates do not both succeed (200+ rounds)", async () => {
    const { createS3StorageAdapter } = await import("../../lib/storage/s3-adapter.mjs");
    assert.ok(s3Config);
    const rounds = Number(process.env.IC_S3_CAS_RACE_ROUNDS ?? "200");
    const adapter = createS3StorageAdapter({
      bucket: s3Config.bucket,
      prefix: `${s3Config.prefix}/cas-race-ci`,
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      casProbe: async () => true,
    });
    await adapter.init();
    const ok = await probeCrossDeviceCasConcurrency(adapter, { rounds });
    console.log(
      `IC_S3_CAS_RACE_CI: rounds=${rounds} ok=${ok} crossDeviceCas=${adapter.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas)}`,
    );
    assert.equal(ok, true, "MinIO must not allow two concurrent create-only puts to succeed");
    await adapter.close();
  });
});

if (requireMinio && !s3Config) {
  throw new Error("IC_REQUIRE_MINIO=1 but S3 test config is missing");
}
