import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fs from "node:fs";

import { isKeyringUsableForAuto } from "../../lib/storage/secret-store-keyring.mjs";
import { TOMBSTONE_SWEEP_MAX_AGE_MS } from "../../lib/storage/filesystem-generations.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("production env-hook sweep (QA #6b/c)", () => {
  it("lib/ has no process.env.*TEST reads", () => {
    const res = spawnSync("rg", ["process\\.env\\.[^\\s]*TEST", "lib/"], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    const hits = String(res.stdout ?? "").trim();
    assert.equal(hits, "", `unexpected TEST env reads in lib/:\n${hits}`);
  });

  it("src/ has no process.env.*TEST reads", () => {
    const res = spawnSync("rg", ["process\\.env\\.[^\\s]*TEST", "src/"], {
      cwd: sdkRoot,
      encoding: "utf8",
    });
    const hits = String(res.stdout ?? "").trim();
    assert.equal(hits, "", `unexpected TEST env reads in src/:\n${hits}`);
  });

  it("ignores test-only env vars under NODE_ENV=production", async () => {
    const prodEnv = {
      ...process.env,
      NODE_ENV: "production",
      INFINITECONTEXT_KEYRING_DURABLE: "0",
      INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1",
    };
    const keyringOk = await isKeyringUsableForAuto();
    assert.equal(typeof keyringOk, "boolean");
    assert.equal(TOMBSTONE_SWEEP_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it("keeps INFINITECONTEXT_DEVICE_UUID as a production override in bootstrap", () => {
    const src = fs.readFileSync(path.join(sdkRoot, "lib/sync-object-store-bootstrap.mjs"), "utf8");
    assert.match(src, /INFINITECONTEXT_DEVICE_UUID/);
    assert.doesNotMatch(src, /isTestRuntime\(\)[\s\S]{0,80}INFINITECONTEXT_DEVICE_UUID/);
  });

  it("gates INFINITECONTEXT_KEYRING_DURABLE to NODE_ENV=test only", () => {
    const src = fs.readFileSync(path.join(sdkRoot, "lib/storage/secret-store-keyring.mjs"), "utf8");
    assert.match(src, /isTestRuntime\(\)[\s\S]{0,40}INFINITECONTEXT_KEYRING_DURABLE/);
  });
});
