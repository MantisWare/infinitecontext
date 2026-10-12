import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("built CLI bundled crypto", () => {
  it("lib/ic-crypto.mjs exists after build and validates envelopes", async () => {
    const cryptoPath = path.join(sdkRoot, "lib/ic-crypto.mjs");
    assert.ok(fs.existsSync(cryptoPath), "run pnpm run build first");
    const { isEncryptedContent } = await import(`file://${cryptoPath}`);
    assert.equal(
      isEncryptedContent({
        __ic_enc: 1,
        kid: "dek_v1",
        v: 1,
        alg: "XC20P",
        nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
        ct: "AA==",
      }),
      true,
    );
  });
});
