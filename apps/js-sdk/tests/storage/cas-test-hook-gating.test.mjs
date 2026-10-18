import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { isRaceDoubleWinTestActive, readTestHook } from "../../lib/storage/test-hooks.mjs";
import { wrapCasRaceDoubleWinTestHook } from "../../lib/storage/storage-s3-cas-probe-session.mjs";
import { probeCrossDeviceCasRace } from "../../lib/storage/storage-cas-race-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntry = path.join(repoRoot, "src/cli/entry.mjs");

/**
 * @param {import("../../lib/storage/types.mjs").StorageAdapter} inner
 * @param {boolean} enableHook
 */
function adapterWithRecordedPuts(inner, enableHook) {
  /** @type {Array<{ key: string, ifNoneMatch?: string }>} */
  const puts = [];
  let wrapped = {
    ...inner,
    put(key, body, putOptions) {
      puts.push({ key: String(key), ifNoneMatch: putOptions?.ifNoneMatch });
      return inner.put(key, body, putOptions);
    },
    capabilities: inner.capabilities,
  };
  if (enableHook) {
    wrapped = wrapCasRaceDoubleWinTestHook(wrapped);
  }
  return { adapter: wrapped, puts };
}

describe("CAS race double-win test hook gating", () => {
  it("readTestHook ignores env unless NODE_ENV=test", () => {
    const env = {
      NODE_ENV: "production",
      INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1",
    };
    assert.equal(readTestHook("raceDoubleWin", env), undefined);
    assert.equal(isRaceDoubleWinTestActive({}, env), false);
  });

  it("NODE_ENV unset + hook=1 keeps ifNoneMatch on ic-cas-race puts", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const env = { INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1" };
    const { adapter, puts } = adapterWithRecordedPuts(inner, isRaceDoubleWinTestActive({}, env));
    const key = "ic-cas-race/gating.unset-env";
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ifNoneMatch, "*");
    await inner.close();
  });

  it("NODE_ENV=production + hook=1 keeps ifNoneMatch (production ignores hook)", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const env = {
      NODE_ENV: "production",
      INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1",
    };
    const { adapter, puts } = adapterWithRecordedPuts(inner, isRaceDoubleWinTestActive({}, env));
    const key = "ic-cas-race/gating.production";
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ifNoneMatch, "*");
    await inner.close();
  });

  it("NODE_ENV=test + hook=1 drops ifNoneMatch on ic-cas-race puts", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const env = { NODE_ENV: "test", INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1" };
    const { adapter, puts } = adapterWithRecordedPuts(inner, isRaceDoubleWinTestActive({}, env));
    const key = "ic-cas-race/gating.test-env";
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ifNoneMatch, undefined);
    await inner.close();
  });

  it("testHooks.raceDoubleWin injection drops ifNoneMatch regardless of NODE_ENV", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const env = {
      NODE_ENV: "production",
      INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1",
    };
    const { adapter, puts } = adapterWithRecordedPuts(
      inner,
      isRaceDoubleWinTestActive({ testHooks: { raceDoubleWin: true } }, env),
    );
    const key = "ic-cas-race/gating.injection";
    await adapter.put(key, sampleEncryptedObjectBytesForKey(key), { ifNoneMatch: "*" });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ifNoneMatch, undefined);
    await inner.close();
  });

});

/**
 * @returns {{ bucket: string, prefix: string, region: string, endpoint?: string } | null}
 */
function resolveS3AdapterTestConfigFromEnv(env = process.env) {
  const bucket = String(env.INFINITECONTEXT_S3_TEST_BUCKET ?? "").trim();
  const endpoint = String(env.AWS_ENDPOINT_URL ?? env.INFINITECONTEXT_S3_ENDPOINT ?? "").trim();
  if (!bucket || !endpoint) {
    return null;
  }
  return {
    bucket,
    prefix: String(env.INFINITECONTEXT_S3_TEST_PREFIX ?? "ic-s3-test").replace(/\/+$/, ""),
    region: String(env.AWS_REGION ?? "us-east-1"),
    endpoint,
  };
}

/**
 * @param {string} homeDir
 * @param {string} prefix
 * @param {{ bucket: string, region: string, endpoint?: string }} s3Config
 */
function writeS3ConfigInHome(homeDir, prefix, s3Config) {
  const config = {
    storage: {
      backend: "s3",
      s3: {
        bucket: s3Config.bucket,
        prefix,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
      },
    },
  };
  const dir = path.join(homeDir, ".infinitecontext");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const s3Config = resolveS3AdapterTestConfigFromEnv(process.env);

(s3Config ? describe : describe.skip)("CAS hook gating — spawned storage doctor CLI", () => {
  it("NODE_ENV=production + hook=1 does not report false double-win", () => {
    assert.ok(s3Config);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-home-gating-"));
    const prefix = `${s3Config.prefix}/hook-gating-${Date.now()}`;
    writeS3ConfigInHome(homeDir, prefix, s3Config);
    const res = spawnSync(process.execPath, [cliEntry, "storage", "doctor", "--cas-race=5"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        NODE_ENV: "production",
        INFINITECONTEXT_S3_CAS_RACE_DOUBLE_WIN_TEST: "1",
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const text = String(res.stdout).trim();
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    const result = JSON.parse(text.slice(first, last + 1));
    assert.equal(result.ok, true);
    assert.equal(result.persistedUnsafe, false);
  });
});

describe("probeCrossDeviceCasRace with gated hook semantics", () => {
  it("double-win wrap fails race probe; strict ifNoneMatch passes on memory adapter", async () => {
    const inner = createMemoryStorageAdapter();
    await inner.init();
    const broken = wrapCasRaceDoubleWinTestHook(inner);
    const bad = await probeCrossDeviceCasRace(broken, { rounds: 3 });
    assert.equal(bad.ok, false);
    assert.equal(bad.detail, "double_win");
    const good = await probeCrossDeviceCasRace(inner, { rounds: 3 });
    assert.equal(good.ok, true);
    await inner.close();
  });
});
