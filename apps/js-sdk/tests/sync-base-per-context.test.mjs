import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InfiniteContext } from "../dist/index.mjs";

function mockFetch(handlers) {
  return async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unhandled ${key}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init.headers ?? {};
    const json = await handler({ body, url: u, headers });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function baseFromHeaders(headers) {
  const h = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
  return h["X-IC-Base-Sequence"] ?? h["x-ic-base-sequence"];
}

describe("per-context sync base (plain SDK)", () => {
  it("read C, B edits C, read X, delete in C — uses C base not X", async () => {
    let deleteBase;
    const client = new InfiniteContext({
      apiKey: "ic_test_key",
      baseUrl: "http://mock",
      fetch: mockFetch({
        "GET /contexts/ctx_c": async () => ({
          data: [{ id: "msg_c", index: 0, metadata: { ic_client_node_id: "icn_" + "c".repeat(24) }, text: "c" }],
          version: 0,
          sync_base_sequence: 5,
        }),
        "GET /contexts/ctx_x": async () => ({
          data: [],
          version: 0,
          sync_base_sequence: 99,
        }),
        "DELETE /contexts/ctx_c": async ({ headers, body }) => {
          deleteBase = baseFromHeaders(headers);
          assert.equal(body.base_sequence, undefined);
          return { data: [], version: 1, sync_base_sequence: 6 };
        },
      }),
    });

    await client.get("ctx_c");
    await client.get("ctx_x");
    await client.delete("ctx_c", 0);
    assert.equal(deleteBase, "5");
  });

  it("read C, append to C, delete — append does not refresh base", async () => {
    let deleteBase;
    const client = new InfiniteContext({
      apiKey: "ic_test_key",
      baseUrl: "http://mock",
      fetch: mockFetch({
        "GET /contexts/ctx_c": async () => ({
          data: [{ id: "msg_c", index: 0, metadata: { ic_client_node_id: "icn_" + "c".repeat(24) }, text: "c" }],
          version: 0,
          sync_base_sequence: 5,
        }),
        "POST /contexts/ctx_c": async () => ({
          data: [{ id: "msg_new", index: 1, metadata: {}, text: "n" }],
          version: 1,
          sync_base_sequence: 88,
        }),
        "DELETE /contexts/ctx_c": async ({ headers }) => {
          deleteBase = baseFromHeaders(headers);
          return { data: [], version: 2, sync_base_sequence: 6 };
        },
      }),
    });

    await client.get("ctx_c");
    await client.append("ctx_c", { role: "user", text: "n" });
    await client.delete("ctx_c", 0);
    assert.equal(deleteBase, "5");
  });

  it("noteSyncBaseFromPull updates only the given context", async () => {
    let deleteBase;
    const client = new InfiniteContext({
      apiKey: "ic_test_key",
      baseUrl: "http://mock",
      fetch: mockFetch({
        "GET /contexts/ctx_a": async () => ({
          data: [{ id: "msg_a", index: 0, metadata: {}, text: "a" }],
          version: 0,
          sync_base_sequence: 3,
        }),
        "DELETE /contexts/ctx_b": async ({ headers }) => {
          deleteBase = baseFromHeaders(headers);
          return { data: [], version: 1 };
        },
      }),
    });

    await client.get("ctx_a");
    client.noteSyncBaseFromPull("ctx_b", 12);
    await client.delete("ctx_b", 0);
    assert.equal(deleteBase, "12");
  });

  it("advances base after own PATCH then DELETE without false stale", async () => {
    const calls = [];
    const client = new InfiniteContext({
      apiKey: "ic_test_key",
      baseUrl: "http://mock",
      fetch: mockFetch({
        "GET /contexts/ctx_c": async () => ({
          data: [{ id: "msg_c", index: 0, metadata: { ic_client_node_id: "icn_" + "c".repeat(24) }, text: "c" }],
          version: 0,
          sync_base_sequence: 5,
        }),
        "PATCH /contexts/ctx_c": async ({ headers }) => {
          calls.push(["patch", baseFromHeaders(headers)]);
          return { data: [{ id: "msg_c", index: 0, text: "new" }], version: 1, sync_base_sequence: 6 };
        },
        "DELETE /contexts/ctx_c": async ({ headers }) => {
          calls.push(["delete", baseFromHeaders(headers)]);
          return { data: [], version: 2, sync_base_sequence: 7 };
        },
      }),
    });

    await client.get("ctx_c");
    await client.update("ctx_c", { index: 0, text: "new" });
    await client.delete("ctx_c", 0);
    assert.deepEqual(calls, [
      ["patch", "5"],
      ["delete", "6"],
    ]);
  });
});
