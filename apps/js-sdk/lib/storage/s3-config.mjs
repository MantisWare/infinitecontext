import { StorageError } from "./errors.mjs";

export const S3_OBJECT_STORE_BACKEND_ID = "s3";

/**
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveS3ObjectStoreConfig(config = {}, env = process.env) {
  const storage = config.storage;
  const s3Block =
    storage && typeof storage === "object" && !Array.isArray(storage)
      ? /** @type {Record<string, unknown>} */ (storage).s3
      : null;
  const fromBlock =
    s3Block && typeof s3Block === "object" && !Array.isArray(s3Block)
      ? /** @type {Record<string, unknown>} */ (s3Block)
      : {};

  const bucket = String(
    env.INFINITECONTEXT_S3_BUCKET ?? fromBlock.bucket ?? "",
  ).trim();
  if (!bucket) {
    throw new StorageError(
      "storage.s3.bucket (or INFINITECONTEXT_S3_BUCKET) is required when storage.backend=s3",
      "invalid_argument",
    );
  }

  const prefix = String(
    env.INFINITECONTEXT_S3_PREFIX ?? fromBlock.prefix ?? "infinitecontext",
  )
    .trim()
    .replace(/^\/+|\/+$/g, "");

  const region = String(env.AWS_REGION ?? fromBlock.region ?? "us-east-1").trim();
  const endpoint = String(
    env.AWS_ENDPOINT_URL ?? env.INFINITECONTEXT_S3_ENDPOINT ?? fromBlock.endpoint ?? "",
  ).trim();

  return {
    bucket,
    prefix,
    region,
    endpoint: endpoint || undefined,
  };
}
