import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = String(process.env.INFINITECONTEXT_S3_TEST_BUCKET ?? "infinitecontext-ci");
const endpoint = String(process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:9000");

const client = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`minio-init: bucket ${bucket} already exists`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`minio-init: created bucket ${bucket}`);
}
