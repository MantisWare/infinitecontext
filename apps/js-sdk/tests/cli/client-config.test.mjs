import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HOSTED_API_BASE_URL,
  resolveBaseUrl,
  writeConfigFile,
  isHostedApiBaseUrl,
} from "../../lib/client-config.mjs";

describe("client-config base URL", () => {
  /** @type {string | undefined} */
  let previousHome;
  /** @type {string | undefined} */
  let previousBaseUrl;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousBaseUrl = process.env.INFINITECONTEXT_BASE_URL;
    delete process.env.INFINITECONTEXT_BASE_URL;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ic-client-config-"));
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    if (previousBaseUrl === undefined) delete process.env.INFINITECONTEXT_BASE_URL;
    else process.env.INFINITECONTEXT_BASE_URL = previousBaseUrl;
  });

  it("defaults to hosted API URL", () => {
    assert.equal(resolveBaseUrl(), HOSTED_API_BASE_URL);
    assert.equal(isHostedApiBaseUrl(HOSTED_API_BASE_URL), true);
  });

  it("reads base URL from config.json", () => {
    writeConfigFile({ baseUrl: "http://127.0.0.1:8787" });
    assert.equal(resolveBaseUrl(), "http://127.0.0.1:8787");
    assert.equal(isHostedApiBaseUrl(resolveBaseUrl()), false);
  });
});
