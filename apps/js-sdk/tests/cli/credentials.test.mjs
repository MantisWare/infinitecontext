import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearCredentials,
  credentialsPath,
  loadCredentials,
  saveCredentials,
} from "../../lib/credentials.mjs";

describe("credentials storage", () => {
  /** @type {string | undefined} */
  let previousHome;

  beforeEach(() => {
    previousHome = process.env.HOME;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ic-credentials-"));
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("writes credentials with mode 0600 under ~/.infinitecontext", () => {
    saveCredentials({
      baseUrl: "http://127.0.0.1:8787",
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
      email: "user@example.com",
    });

    const loaded = loadCredentials();
    assert.equal(loaded.email, "user@example.com");
    assert.equal(loaded.refreshToken, "refresh");

    const stat = fs.statSync(credentialsPath());
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it("clears credentials on logout helper", () => {
    saveCredentials({ refreshToken: "x" });
    clearCredentials();
    assert.equal(loadCredentials(), null);
  });
});
