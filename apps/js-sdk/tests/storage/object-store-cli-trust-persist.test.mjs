import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateClientNodeId } from "../../lib/ic-crypto.mjs";
import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { ObjectStoreLogRollbackError } from "../../lib/object-store-local-sync-state.mjs";
import { setDefaultSyncTransport } from "../../lib/sync-transport.mjs";
import { normalizeVectorSyncCursor } from "../../lib/sync-cursor.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { ObjectStoreSyncTransport } from "../../lib/storage/object-store-sync-transport.mjs";

const TEST_DEK = new Uint8Array(32).fill(13);
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LAYOUT = "accounts/cli-trust";

describe("CLI pull preserves object store trust", () => {
  it("keeps trusted heads after CLI cursor write and detects deleted tip", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ic-cli-trust-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    process.env.INFINITECONTEXT_CONFIG_HOME = home;
    try {
      const adapter = createMemoryStorageAdapter();
      await adapter.init();
      const objectStatePath = path.join(home, ".infinitecontext", "object-store-sync-state.json");
      const cliStatePath = path.join(home, ".infinitecontext", "sync-cli-state.json");
      fs.mkdirSync(path.dirname(objectStatePath), { recursive: true });
      const local = createCliFileObjectStoreLocalState(objectStatePath);
      const transport = new ObjectStoreSyncTransport(adapter, {
        dek: TEST_DEK,
        deviceUuid: DEVICE_A,
        layoutPrefix: LAYOUT,
        localState: local,
      });
      setDefaultSyncTransport(transport);

      await transport.pushSyncMutations([
        { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { one: 1 } } },
      ]);
      await transport.pushSyncMutations([
        { client_id: generateClientNodeId(), op: "context_create", payload: { metadata: { two: 2 } } },
      ]);

      const beforeTrust = local.load().trustedHeads;
      assert.ok(Object.keys(beforeTrust).length > 0);

      fs.writeFileSync(cliStatePath, `${JSON.stringify({ cursor: normalizeVectorSyncCursor(0) }, null, 2)}\n`, {
        mode: 0o600,
      });
      assert.ok(fs.existsSync(cliStatePath));
      const cliRaw = JSON.parse(fs.readFileSync(cliStatePath, "utf8"));
      assert.equal(cliRaw.objectStoreSync, undefined);

      const afterTrust = local.load().trustedHeads;
      assert.deepEqual(afterTrust, beforeTrust);
      assert.ok(fs.existsSync(objectStatePath));

      const listed = await adapter.list(`${LAYOUT}/ic-v1/log/`, { limit: 20 });
      const lastKey = listed.objects.map((o) => o.key).sort().at(-1);
      assert.ok(lastKey);
      await adapter.delete(lastKey);

      await assert.rejects(
        () => transport.pullSyncChanges({ since: local.load().vectorCursor, limit: 5 }),
        (err) => err instanceof ObjectStoreLogRollbackError,
      );
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
