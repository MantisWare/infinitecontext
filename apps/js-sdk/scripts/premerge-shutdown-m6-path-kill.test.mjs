import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shutdownSrc = fs.readFileSync(path.join(sdkRoot, "scripts/premerge-shutdown.mjs"), "utf8");
const processUtilsSrc = fs.readFileSync(path.join(sdkRoot, "scripts/premerge-process-utils.mjs"), "utf8");

describe("S-M6 source regression (path kill in production)", () => {
  it("finishShutdown kills processes using premerge TMPDIR (not PREMERGE_MUTANT-only)", () => {
    assert.match(
      shutdownSrc,
      /function finishShutdown\(\)\s*\{[\s\S]*if \(!hasPremergeMutant\("M6"\)\)\s*\{[\s\S]*killProcessesUsingPath\(premergeTmpRoot/,
      "finishShutdown must call killProcessesUsingPath on the private tmp root",
    );
  });

  it("removePrivateTmpDirVerified kills path users before rm (not PREMERGE_MUTANT-only)", () => {
    assert.match(
      processUtilsSrc,
      /function removePrivateTmpDirVerified[\s\S]*killProcessesUsingPath\(root/,
      "TMPDIR removal must invoke killProcessesUsingPath",
    );
    assert.doesNotMatch(
      processUtilsSrc,
      /if \(false\)\s*\{\s*killProcessesUsingPath\(root/,
      "path kill must not be permanently disabled in production",
    );
  });
});
