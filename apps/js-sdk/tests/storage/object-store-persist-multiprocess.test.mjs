import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { createCliFileObjectStoreLocalState } from "../../lib/object-store-local-state-persist.mjs";
import { ObjectStoreSyncStateError } from "../../lib/object-store-state-errors.mjs";

describe("object store persisted localState", () => {
  it("fails closed on corrupt state file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-os-corrupt-")), "sync-cli-state.json");
    fs.writeFileSync(file, "{ not-json", "utf8");
    const backend = createCliFileObjectStoreLocalState(file);
    assert.throws(() => backend.load(), (err) => err instanceof ObjectStoreSyncStateError);
  });

  it("merges trusted heads from two processes on one state file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-os-mp-"));
    const file = path.join(dir, "sync-cli-state.json");
    const persistUrl = pathToFileURL(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../lib/object-store-local-state-persist.mjs"),
    ).href;
    const childScript = path.join(dir, "writer.mjs");
    fs.writeFileSync(
      childScript,
      `
import { createCliFileObjectStoreLocalState } from ${JSON.stringify(persistUrl)};
const backend = createCliFileObjectStoreLocalState(${JSON.stringify(file)});
const state = backend.load();
state.trustedHeads[process.argv[2]] = { seq: Number(process.argv[3]), digest: process.argv[4] };
state.selfNextSeq = Math.max(state.selfNextSeq, Number(process.argv[3]) + 1);
backend.save(state);
`,
    );
    const run = (devH, seq, digest) =>
      spawnSync(process.execPath, [childScript, devH, String(seq), digest], { stdio: "pipe" });
    assert.equal(run("AAAAAAAAAAAAAAAAAAAAAAAAAA", 2, "a".repeat(64)).status, 0);
    assert.equal(run("BBBBBBBBBBBBBBBBBBBBBBBBBB", 4, "b".repeat(64)).status, 0);
    const merged = createCliFileObjectStoreLocalState(file).load();
    assert.equal(merged.trustedHeads.AAAAAAAAAAAAAAAAAAAAAAAAAA.seq, 2);
    assert.equal(merged.trustedHeads.BBBBBBBBBBBBBBBBBBBBBBBBBB.seq, 4);
  });
});
