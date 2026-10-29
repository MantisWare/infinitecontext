import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { CreateBucketCommand, HeadBucketCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";

import { runStorageAdapterContractSuite, sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";

/**
 * @returns {{ bucket: string, prefix: string, region: string, endpoint?: string } | null}
 */
export function resolveS3AdapterTestConfigFromEnv(env = process.env) {
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

const s3ConfigRaw = resolveS3AdapterTestConfigFromEnv();

if (process.env.IC_REQUIRE_MINIO === "1" && !s3ConfigRaw) {
  throw new Error(
    "IC_REQUIRE_MINIO=1 but S3 test config is missing (set AWS_ENDPOINT_URL and INFINITECONTEXT_S3_TEST_BUCKET)",
  );
}

/**
 * @param {{ bucket: string, prefix: string, region: string, endpoint?: string }} cfg
 */
async function ensureS3TestBackendReady(cfg) {
  const probeClient = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
  });
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await probeClient.send(new ListBucketsCommand({}));
        break;
      } catch (error) {
        if (attempt === 19) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    try {
      await probeClient.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    } catch (error) {
      const status =
        error && typeof error === "object" && "$metadata" in error
          ? Number(/** @type {{ httpStatusCode?: number }} */ (error.$metadata).httpStatusCode)
          : undefined;
      const missing = status === 404 || (error && typeof error === "object" && error.name === "NotFound");
      if (missing) {
        await probeClient.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      } else {
        throw error;
      }
    }
    return cfg;
  } finally {
    probeClient.destroy();
  }
}

/** @type {{ bucket: string, prefix: string, region: string, endpoint?: string } | null} */
let s3Config = null;
if (s3ConfigRaw) {
  try {
    s3Config = await ensureS3TestBackendReady(s3ConfigRaw);
  } catch (error) {
    if (process.env.IC_REQUIRE_MINIO === "1") {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`IC_REQUIRE_MINIO=1 but MinIO/S3 endpoint is unreachable (${detail})`);
    }
  }
}

/**
 * @param {import("../../lib/storage/types.mjs").StorageAdapter} adapter
 */
function mirrorBackingForContractTests(adapter) {
  /** @type {Map<string, Uint8Array>} */
  const bodies = new Map();
  return {
    async put(key, body, opts) {
      const res = await adapter.put(key, body, opts);
      bodies.set(key, body.slice());
      return res;
    },
    async delete(key, opts) {
      await adapter.delete(key, opts);
      bodies.delete(key);
    },
    inspectBacking: () => ({
      keys: [...bodies.keys()],
      bodies: [...bodies.values()],
      metadata: [],
    }),
  };
}

(s3Config ? describe : describe.skip)("S3 storage adapter (MinIO / CI)", () => {
  runStorageAdapterContractSuite(
    async () => {
      const { createS3StorageAdapter } = await import("../../lib/storage/s3-adapter.mjs");
      assert.ok(s3Config);
      const base = createS3StorageAdapter({
        bucket: s3Config.bucket,
        prefix: `${s3Config.prefix}/${randomBytes(4).toString("hex")}`,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      });
      await base.init();
      const mirror = mirrorBackingForContractTests(base);
      const adapter = {
        ...base,
        put: mirror.put,
        delete: mirror.delete,
      };
      return {
        adapter,
        inspectBacking: mirror.inspectBacking,
      };
    },
    { describe, it },
    {
      requiredCapabilities: [
        STORAGE_CAPABILITIES.get,
        STORAGE_CAPABILITIES.head,
        STORAGE_CAPABILITIES.put,
        STORAGE_CAPABILITIES.list,
        STORAGE_CAPABILITIES.delete,
        STORAGE_CAPABILITIES.conditionalCreate,
        STORAGE_CAPABILITIES.conditionalReplace,
      ],
    },
  );

  it("advertises crossDeviceCas only when conditional probe succeeds", async () => {
    const { createS3StorageAdapter } = await import("../../lib/storage/s3-adapter.mjs");
    assert.ok(s3Config);
    const adapter = createS3StorageAdapter({
      bucket: s3Config.bucket,
      prefix: `${s3Config.prefix}/probe-${randomBytes(4).toString("hex")}`,
      region: s3Config.region,
      endpoint: s3Config.endpoint,
    });
    await adapter.init();
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
    await adapter.close();
  });

  it("createS3ObjectStore round-trips a sealed vault object", async () => {
    const { createS3ObjectStore } = await import("../../lib/storage/s3-object-store.mjs");
    const { encryptVaultPlaintextForStoragePut } = await import("../../lib/storage/encrypt-storage-object.mjs");
    assert.ok(s3Config);
    const dek = new Uint8Array(32).fill(41);
    const deviceUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const prefix = `${s3Config.prefix}/e2e-${randomBytes(4).toString("hex")}`;
    const store = await createS3ObjectStore({
      config: {
        storage: {
          backend: "s3",
          s3: { bucket: s3Config.bucket, prefix, region: s3Config.region, endpoint: s3Config.endpoint },
        },
      },
      env: process.env,
      dek,
      deviceUuid,
      layoutPrefix: "accounts/local",
      sync: { persist: false },
    });
    assert.match(store.bindingKey, /^s3:[^:]+:[^:]+$/);
    assert.ok(store.bindingKey.startsWith(`s3:${s3Config.bucket}:`));
    assert.equal(store.adapter.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), true);
    const objectKey = "accounts/local/ic-v1/e2e/ping.enc";
    const sealed = encryptVaultPlaintextForStoragePut(dek, objectKey, { ping: "s3-e2e" });
    await store.transport.putObject(objectKey, sealed);
    const got = await store.adapter.get(objectKey);
    assert.ok(got?.body?.length);
    await store.close();
  });

  it("maps failed If-Match to PreconditionFailedError", async () => {
    const { createS3StorageAdapter } = await import("../../lib/storage/s3-adapter.mjs");
    assert.ok(s3Config);
    const adapter = createS3StorageAdapter({
      bucket: s3Config.bucket,
      prefix: `${s3Config.prefix}/pre-${randomBytes(4).toString("hex")}`,
      region: s3Config.region,
      endpoint: s3Config.endpoint,
    });
    await adapter.init();
    const key = "pre/cond.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    const created = await adapter.put(key, body, { ifNoneMatch: "*" });
    await assert.rejects(
      () => adapter.put(key, body, { ifMatch: '"deadbeef"' }),
      (err) => err instanceof PreconditionFailedError,
    );
    await adapter.put(key, body, { ifMatch: created.etag });
    await adapter.close();
  });
});

describe("S3 storage adapter (offline)", () => {
  it("resolveS3AdapterTestConfigFromEnv returns null without MinIO env", () => {
    assert.equal(resolveS3AdapterTestConfigFromEnv({}), null);
  });
});
