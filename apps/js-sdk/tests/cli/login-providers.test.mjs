import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

describe("login google provider gate", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("exits when Google is disabled on the server", async () => {
    process.env.INFINITECONTEXT_BASE_URL = "http://127.0.0.1:8787";
    mock.method(globalThis, "fetch", async (url) => {
      if (String(url).endsWith("/auth/providers")) {
        return new Response(JSON.stringify({ password: true, google: false }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { runLogin } = await import("../../src/cli/login.mjs");
    await runLogin(["--google"]);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});
