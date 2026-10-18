import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PreconditionFailedError, RateLimitedError, StorageError } from "../../lib/storage/errors.mjs";
import { redactS3ErrorMessage } from "../../lib/storage/s3-error-sanitize.mjs";
import { createS3StorageAdapter } from "../../lib/storage/s3-adapter.mjs";

describe("S3 adapter error mapping + redaction", () => {
  it("redacts AWS access keys and SigV4 fields from messages", () => {
    const raw =
      "Request failed AKIAIOSFODNN7EXAMPLE X-Amz-Signature=abc123 X-Amz-Credential=AKIAIOSFODNN7EXAMPLE/20260101/us-east-1/s3/aws4_request";
    const out = redactS3ErrorMessage(raw);
    assert.match(out, /AKIA\*\*\*/);
    assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
    assert.match(out, /\[redacted-sigv4\]/);
  });

  it("maps 403 to permission_denied (not auth expired)", async () => {
    const adapter = createS3StorageAdapter({
      bucket: "b",
      region: "us-east-1",
      client: {
        send: async () => {
          const err = new Error("Forbidden");
          err.name = "Forbidden";
          err.$metadata = { httpStatusCode: 403 };
          throw err;
        },
        destroy: () => {},
      },
    });
    await assert.rejects(() => adapter.init(), (err) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, "permission_denied");
      assert.ok(!(err.name === "AuthExpiredError"));
      return true;
    });
  });

  it("maps 503 to RateLimitedError after retries exhaust", async () => {
    const adapter = createS3StorageAdapter({
      bucket: "b",
      region: "us-east-1",
      client: {
        send: async () => {
          const err = new Error("SlowDown");
          err.name = "SlowDown";
          err.$metadata = { httpStatusCode: 503, httpHeaders: { "retry-after": "0" } };
          throw err;
        },
        destroy: () => {},
      },
    });
    await assert.rejects(() => adapter.init(), (err) => err instanceof RateLimitedError);
  });
});
