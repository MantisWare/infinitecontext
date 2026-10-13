import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enginePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib/sync-engine.mjs");

describe("pullAndApplySync paging", () => {
  it("persists replica once per page and saves cursor inside the pull loop", () => {
    const src = fs.readFileSync(enginePath, "utf8");
    assert.match(src, /applySyncChangeToReplica\(replica, change, \(\) => \{\}\)/);
    const loopStart = src.indexOf("while (hasMore)");
    const loopEnd = src.indexOf("return { applied: total");
    const loop = src.slice(loopStart, loopEnd);
    assert.match(loop, /if \(replica\) persistReplica\(\)/);
    assert.match(loop, /writeCursor\(since\)/);
    assert.doesNotMatch(loop, /fetchSyncStatus/);
  });
});
