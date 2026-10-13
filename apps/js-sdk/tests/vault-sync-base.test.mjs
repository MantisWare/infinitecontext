import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("vault client sync base capture", () => {
  it("does not adopt sync_base_sequence from PATCH; keeps last GET base for delete", async () => {
    const mod = await import("../lib/encrypted-client.mjs");
    let deleteBase;
    const client = {
      async get() {
        return {
          sync_base_sequence: 5,
          data: [
            {
              id: "msg_1",
              index: 0,
              metadata: { ic_client_node_id: "icn_" + "a".repeat(24) },
              role: "user",
              text: "a",
            },
          ],
        };
      },
      async update() {
        return { sync_base_sequence: 99, data: [{ id: "msg_1", index: 0, metadata: {}, role: "user", text: "b" }] };
      },
      async delete(_id, _input, options) {
        deleteBase = options?.base_sequence;
        return { data: [] };
      },
    };
    const vault = mod.wrapInfiniteContextWithVault(
      client,
      { dek: new Uint8Array(32).fill(1), dekVersion: 1, userPublicId: "usr_test" },
      { migrationMode: true },
    );
    await vault.get("ctx_test");
    await vault.update("ctx_test", { index: 0, text: "b" });
    await vault.delete("ctx_test", 0);
    assert.equal(deleteBase, 5);
  });

  it("keeps per-context base when reading another context", async () => {
    const mod = await import("../lib/encrypted-client.mjs");
    let deleteBase;
    const client = {
      async get(id) {
        if (id === "ctx_c") {
          return {
            sync_base_sequence: 5,
            data: [
              {
                id: "msg_1",
                index: 0,
                metadata: { ic_client_node_id: "icn_" + "a".repeat(24) },
                role: "user",
                text: "a",
              },
            ],
          };
        }
        return { sync_base_sequence: 50, data: [] };
      },
      async delete(_id, _input, options) {
        deleteBase = options?.base_sequence;
        return { data: [] };
      },
    };
    const vault = mod.wrapInfiniteContextWithVault(
      client,
      { dek: new Uint8Array(32).fill(1), dekVersion: 1, userPublicId: "usr_test" },
      { migrationMode: true },
    );
    await vault.get("ctx_c");
    await vault.get("ctx_other");
    await vault.delete("ctx_c", 0);
    assert.equal(deleteBase, 5);
  });
});
