import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runConfigCli } from "../../src/cli/config-cli.mjs";
import { readConfigFile } from "../../lib/client-config.mjs";

describe("config cli", () => {
  /** @type {string | undefined} */
  let previousHome;

  beforeEach(() => {
    previousHome = process.env.HOME;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ic-config-cli-"));
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("set server writes baseUrl to config.json", async () => {
    await runConfigCli(["set", "server", "http://127.0.0.1:8787"]);
    const cfg = readConfigFile();
    assert.equal(cfg.baseUrl, "http://127.0.0.1:8787");
  });
});
