import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { encryptVaultPlaintextForStoragePut } from "../../lib/storage/encrypt-storage-object.mjs";
import { copyVerifiedStoragePutBodyForAdapter } from "../../lib/storage/encrypt-storage-object.mjs";
import { scanStorageObjectForLeaks } from "../../lib/storage/ciphertext.mjs";
import { encryptLogSegment, logSegmentRelativePath } from "../../lib/storage/layout.mjs";

const TEST_DEK = new Uint8Array(32).fill(9);

describe("storage leak scan regression", () => {
  it("accepts 10k random encrypted segment puts without false positives", async () => {
    const adapter = createMemoryStorageAdapter();
    await adapter.init();
    const devH = "ABCDEFGHJKMNPQRSTVWXYZ2345";
    for (let seq = 0; seq < 10_000; seq += 1) {
      const record = {
        dev: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        seq,
        prev_digest: seq === 0 ? "" : "a".repeat(64),
        created_at: new Date().toISOString(),
        mutations: [
          {
            client_id: generateClientNodeId(),
            op: "context_create",
            payload: { metadata: { source: "leak-scan", token_like: "not-in-ciphertext-scan" } },
            hlc: { wall_ms: seq, counter: 0, devH },
          },
        ],
      };
      const envelope = encryptLogSegment(TEST_DEK, devH, record);
      const key = logSegmentRelativePath("accounts/leak", devH, seq);
      const sealed = encryptVaultPlaintextForStoragePut(TEST_DEK, key, {
        ic_layout_segment_envelope_v1: envelope,
      });
      const body = copyVerifiedStoragePutBodyForAdapter(sealed);
      assert.doesNotThrow(() => scanStorageObjectForLeaks(key, body));
      if (seq % 500 === 0) {
        await adapter.put(key, body, { ifNoneMatch: "*" });
      }
    }
  });
});
