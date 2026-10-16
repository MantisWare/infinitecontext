import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { NotSupportedError } from "../../lib/storage/errors.mjs";
import { createS3StorageAdapter } from "../../lib/storage/s3-adapter.mjs";
import { STORAGE_CAPABILITIES } from "../../lib/storage/types.mjs";

describe("S3 adapter precondition fail-closed", () => {
  it("drops conditional capabilities and rejects precondition puts when probe fails", async () => {
    const adapter = createS3StorageAdapter({
      bucket: "unused",
      prefix: "t",
      region: "us-east-1",
      casProbe: async () => false,
      client: /** @type {import("@aws-sdk/client-s3").S3Client} */ ({
        send: async () => ({}),
        destroy: () => {},
      }),
    });
    await adapter.init();
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalCreate), false);
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.conditionalReplace), false);
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.strongListAfterWrite), false);
    assert.equal(adapter.capabilities.has(STORAGE_CAPABILITIES.crossDeviceCas), false);

    const key = "fail/closed.enc";
    const body = sampleEncryptedObjectBytesForKey(key);
    await assert.rejects(
      () => adapter.put(key, body, { ifNoneMatch: "*" }),
      (err) => err instanceof NotSupportedError,
    );
    await assert.rejects(
      () => adapter.put(key, body, { ifMatch: '"x"' }),
      (err) => err instanceof NotSupportedError,
    );
    await adapter.close();
  });
});
