import S3rver from "s3rver";

const port = Number(process.env.IC_S3_CI_PORT ?? 9000);
const address = process.env.IC_S3_CI_HOST ?? "0.0.0.0";
const bucket = String(process.env.INFINITECONTEXT_S3_TEST_BUCKET ?? "infinitecontext-ci");

const server = new S3rver({
  port,
  address,
  silent: true,
  configureBuckets: [{ name: bucket, configs: [] }],
});

await server.run();
console.log(`IC_S3_CI: listening on http://${address}:${port} bucket=${bucket}`);
