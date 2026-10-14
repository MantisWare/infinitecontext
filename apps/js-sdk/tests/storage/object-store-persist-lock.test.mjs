import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  acquireObjectStoreStateLock,
  breakStaleObjectStoreStateLock,
  isStaleObjectStoreStateLock,
  releaseObjectStoreStateLock,
} from "../../lib/object-store-state-lock.mjs";
import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";

describe("object store state lock", () => {
  it("does not treat live pid on same host as stale", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-os-lock-live-"));
    const lockPath = path.join(dir, "state.json.lock");
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: Date.now() - 120_000, heartbeatAt: Date.now() - 120_000 })}\n`,
    );
    assert.equal(isStaleObjectStoreStateLock(lockPath), false);
  });

  it("breaks lock left by dead pid on same host", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-os-lock-"));
    const stateFile = path.join(dir, "object-store-sync-state.json");
    const lockPath = `${stateFile}.lock`;
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 99999999, hostname: os.hostname(), createdAt: Date.now(), heartbeatAt: Date.now() })}\n`,
    );
    assert.equal(isStaleObjectStoreStateLock(lockPath), true);
    breakStaleObjectStoreStateLock(lockPath);
    const fd = await acquireObjectStoreStateLock(lockPath);
    releaseObjectStoreStateLock(fd, lockPath);
  });

  it("merges 150 + 150 saves from two processes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-os-race-150-"));
    const file = path.join(dir, "object-store-sync-state.json");
    const persistUrl = pathToFileURL(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../lib/object-store-local-state-persist.mjs"),
    ).href;
    const childScript = path.join(dir, "writer.mjs");
    fs.writeFileSync(
      childScript,
      `
import { createCliFileObjectStoreLocalState } from ${JSON.stringify(persistUrl)};
await (async () => {
  const backend = createCliFileObjectStoreLocalState(${JSON.stringify(file)});
  for (let i = 0; i < 150; i += 1) {
    const state = backend.load();
    const devH = process.argv[2];
    const seq = Number(process.argv[3]) + i;
    state.trustedHeads[devH] = { seq, digest: String(seq).padStart(64, "0") };
    state.selfNextSeq = Math.max(state.selfNextSeq, seq + 1);
    await backend.save(state);
  }
})();
`,
    );
    const run = (devH, start) =>
      spawnSync(process.execPath, [childScript, devH, String(start)], { stdio: "pipe" });
    assert.equal(run("AAAAAAAAAAAAAAAAAAAAAAAAAA", 0).status, 0);
    assert.equal(run("BBBBBBBBBBBBBBBBBBBBBBBBBB", 1000).status, 0);
    const merged = createCliFileObjectStoreLocalState(file).load();
    assert.equal(merged.trustedHeads.AAAAAAAAAAAAAAAAAAAAAAAAAA.seq, 149);
    assert.equal(merged.trustedHeads.BBBBBBBBBBBBBBBBBBBBBBBBBB.seq, 1149);
  });
});
