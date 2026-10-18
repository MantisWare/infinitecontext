import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { assertStorageCiphertext, scanStorageObjectForLeaks } from "./ciphertext.mjs";
import {
  assertCanonicalStorageObjectKey,
  keyMatchesListPrefix,
  normalizeListPrefix,
} from "./filesystem-keys.mjs";
import {
  AuthExpiredError,
  PreconditionFailedError,
  RateLimitedError,
  StorageError,
} from "./errors.mjs";
import {
  crossDeviceCasCapabilitiesFromProbeResult,
  resolveCrossDeviceCasForAdapterInit,
} from "./storage-cas-init.mjs";
import { storageCasProbeBindingKey } from "./storage-cas-cache.mjs";
import { probeCrossDeviceCas } from "./storage-cas-probe.mjs";
import {
  assertStorageDeletePreconditionsSupported,
  assertStoragePutPreconditionsSupported,
} from "./storage-put-preconditions.mjs";
import { S3_OBJECT_STORE_BACKEND_ID } from "./s3-config.mjs";
import { STORAGE_CAPABILITIES, assertNotAborted, storageCapabilitySet } from "./types.mjs";

/** @param {unknown} error */
function mapS3Error(error) {
  if (!error || typeof error !== "object") {
    return new StorageError(String(error), "storage_error");
  }
  const name = "name" in error ? String(error.name) : "";
  const code =
    "$metadata" in error && error.$metadata && typeof error.$metadata === "object"
      ? Number(/** @type {{ httpStatusCode?: number }} */ (error.$metadata).httpStatusCode)
      : undefined;
  if (name === "PreconditionFailed" || code === 412) {
    return new PreconditionFailedError(
      "message" in error && error.message ? String(error.message) : "Precondition failed",
    );
  }
  if (name === "NotFound" || name === "NoSuchKey" || code === 404) {
    return null;
  }
  if (name === "Forbidden" || code === 403) {
    return new AuthExpiredError("S3 access denied");
  }
  if (code === 429) {
    return new RateLimitedError("S3 rate limit exceeded");
  }
  const message = "message" in error && error.message ? String(error.message) : "S3 request failed";
  return new StorageError(message, "storage_error");
}

/** @param {string | undefined} etag */
function normalizeEtag(etag) {
  const trimmed = String(etag ?? "").trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('"') ? trimmed : `"${trimmed}"`;
}

/** @param {string | undefined} ifMatch */
function s3IfMatchValue(ifMatch) {
  const raw = String(ifMatch ?? "").trim();
  if (!raw) return undefined;
  return raw.startsWith('"') ? raw : `"${raw.replace(/^"+|"+$/g, "")}"`;
}

/**
 * @param {{
 *   bucket: string,
 *   prefix?: string,
 *   region: string,
 *   endpoint?: string,
 *   id?: string,
 *   maxObjectBytes?: number,
 *   client?: import("@aws-sdk/client-s3").S3Client,
 *   casProbe?: (adapter: import("./types.mjs").StorageAdapter) => Promise<boolean>,
 * }} options
 */
export function createS3StorageAdapter(options) {
  const bucket = options.bucket;
  const prefix = String(options.prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const maxObjectBytes = options.maxObjectBytes ?? 8 * 1024 * 1024;

  const client =
    options.client ??
    new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint),
    });

  const runCasProbe = options.casProbe ?? probeCrossDeviceCas;
  const casBindingKey = storageCasProbeBindingKey({
    endpoint: options.endpoint,
    bucket,
    prefix,
  });

  /** @type {import("./types.mjs").StorageCapability[]} */
  let capabilityList = crossDeviceCasCapabilitiesFromProbeResult(null);
  let casProbeActive = false;
  let probeSessionActive = false;

  /** @param {string} logicalKey */
  const toObjectKey = (logicalKey) => {
    const canonical = assertCanonicalStorageObjectKey(logicalKey);
    return prefix ? `${prefix}/${canonical}` : canonical;
  };

  /** @param {string} objectKey */
  const toLogicalKey = (objectKey) => {
    const rel = prefix ? objectKey.slice(prefix.length + 1) : objectKey;
    return assertCanonicalStorageObjectKey(rel);
  };

  /** @type {import("./types.mjs").StorageAdapter} */
  const adapter = {
    id: options.id ?? S3_OBJECT_STORE_BACKEND_ID,
    maxObjectBytes,
    serverSideTimestamps: true,
    capabilities: storageCapabilitySet(capabilityList),

    async init(initOptions = {}) {
      const mode = initOptions.mode ?? "read-write";
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const mapped = mapS3Error(error);
        if (mapped) throw mapped;
        if (mode === "read-only") {
          throw new StorageError("S3 bucket unavailable", "invalid_argument");
        }
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (createError) {
          const createMapped = mapS3Error(createError);
          throw createMapped ?? new StorageError("S3 bucket unavailable", "invalid_argument");
        }
      }
      if (mode === "probe-session") {
        probeSessionActive = true;
        capabilityList = crossDeviceCasCapabilitiesFromProbeResult(true);
        adapter.capabilities = storageCapabilitySet(capabilityList);
        return;
      }
      casProbeActive = true;
      try {
        const resolved = await resolveCrossDeviceCasForAdapterInit(adapter, {
          bindingKey: casBindingKey,
          mode,
          cachePath: initOptions.cachePath,
          runBasicProbe: runCasProbe,
          sweepProbeKeys: initOptions.sweepProbeKeys,
        });
        capabilityList = crossDeviceCasCapabilitiesFromProbeResult(resolved.crossDeviceCas);
      } finally {
        casProbeActive = false;
      }
      adapter.capabilities = storageCapabilitySet(capabilityList);
    },

    async close() {
      client.destroy();
    },

    async get(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const objectKey = toObjectKey(key);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        const body = out.Body ? new Uint8Array(await out.Body.transformToByteArray()) : new Uint8Array();
        return {
          body,
          etag: normalizeEtag(out.ETag),
          size: body.length,
        };
      } catch (error) {
        const mapped = mapS3Error(error);
        if (mapped === null) return null;
        throw mapped;
      }
    },

    async head(key, requestOptions = {}) {
      assertNotAborted(requestOptions.signal);
      const objectKey = toObjectKey(key);
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        return {
          etag: normalizeEtag(out.ETag),
          size: Number(out.ContentLength ?? 0),
        };
      } catch (error) {
        const mapped = mapS3Error(error);
        if (mapped === null) return null;
        throw mapped;
      }
    },

    async put(key, body, putOptions = {}) {
      assertNotAborted(putOptions.signal);
      if (!casProbeActive && !probeSessionActive) {
        assertStoragePutPreconditionsSupported(adapter, putOptions);
      }
      const canonical = assertCanonicalStorageObjectKey(key);
      assertStorageCiphertext(body, { objectKey: canonical });
      scanStorageObjectForLeaks(canonical, body);
      if (body.length > maxObjectBytes) {
        throw new StorageError(`Object exceeds maxObjectBytes (${maxObjectBytes})`, "invalid_argument");
      }
      const objectKey = toObjectKey(canonical);
      /** @type {import("@aws-sdk/client-s3").PutObjectCommandInput} */
      const input = {
        Bucket: bucket,
        Key: objectKey,
        Body: body,
        ContentType: "application/octet-stream",
      };
      if (putOptions.ifNoneMatch === "*") {
        input.IfNoneMatch = "*";
      } else if (putOptions.ifNoneMatch !== undefined) {
        input.IfNoneMatch = s3IfMatchValue(putOptions.ifNoneMatch);
      }
      if (putOptions.ifMatch !== undefined) {
        input.IfMatch = s3IfMatchValue(putOptions.ifMatch);
      }
      try {
        const out = await client.send(new PutObjectCommand(input));
        const modifiedAt = new Date().toISOString();
        return {
          key: canonical,
          etag: normalizeEtag(out.ETag),
          revision: normalizeEtag(out.ETag),
          size: body.length,
          modifiedAt,
        };
      } catch (error) {
        const mapped = mapS3Error(error);
        throw mapped ?? error;
      }
    },

    async list(listPrefix, listOptions = {}) {
      assertNotAborted(listOptions.signal);
      const normalized = normalizeListPrefix(listPrefix);
      const limit = listOptions.limit ?? 1000;
      const logicalCore = normalized.core;
      const s3Prefix = prefix
        ? logicalCore
          ? `${prefix}/${logicalCore}`
          : `${prefix}/`
        : logicalCore || "";
      /** @type {import("./types.mjs").StorageObjectInfo[]} */
      const objects = [];
      let startAfter = listOptions.cursor ? toObjectKey(String(listOptions.cursor)) : undefined;
      let continuationToken;
      while (objects.length < limit) {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: s3Prefix || undefined,
            StartAfter: startAfter,
            ContinuationToken: continuationToken,
            MaxKeys: Math.min(limit - objects.length, 1000),
          }),
        );
        for (const row of out.Contents ?? []) {
          if (!row.Key) continue;
          let logical;
          try {
            logical = toLogicalKey(row.Key);
          } catch {
            continue;
          }
          if (!keyMatchesListPrefix(logical, normalized)) continue;
          objects.push({
            key: logical,
            etag: normalizeEtag(row.ETag),
            revision: normalizeEtag(row.ETag),
            size: Number(row.Size ?? 0),
            modifiedAt: row.LastModified?.toISOString(),
          });
          if (objects.length >= limit) break;
        }
        if (objects.length >= limit || !out.IsTruncated) {
          break;
        }
        continuationToken = out.NextContinuationToken;
        startAfter = undefined;
      }
      const nextCursor = objects.length >= limit ? objects.at(-1)?.key : undefined;
      return { objects, nextCursor };
    },

    async delete(key, deleteOptions = {}) {
      assertNotAborted(deleteOptions.signal);
      if (!casProbeActive && !probeSessionActive) {
        assertStorageDeletePreconditionsSupported(adapter, deleteOptions);
      }
      const objectKey = toObjectKey(key);
      if (deleteOptions.ifMatch !== undefined) {
        const current = await adapter.head(key, deleteOptions);
        if (!current) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        if (current.etag !== normalizeEtag(deleteOptions.ifMatch) && current.etag !== deleteOptions.ifMatch) {
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
      }
      /** @type {import("@aws-sdk/client-s3").DeleteObjectCommandInput} */
      const input = { Bucket: bucket, Key: objectKey };
      if (deleteOptions.ifMatch !== undefined) {
        input.IfMatch = s3IfMatchValue(deleteOptions.ifMatch);
      }
      try {
        await client.send(new DeleteObjectCommand(input));
      } catch (error) {
        const mapped = mapS3Error(error);
        throw mapped ?? error;
      }
    },
  };

  return adapter;
}
