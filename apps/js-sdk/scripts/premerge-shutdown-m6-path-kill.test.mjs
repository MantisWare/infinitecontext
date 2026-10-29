import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shutdownSrc = fs.readFileSync(path.join(sdkRoot, "scripts/premerge-shutdown.mjs"), "utf8");
const processUtilsSrc = fs.readFileSync(path.join(sdkRoot, "scripts/premerge-process-utils.mjs"), "utf8");
const m6Probe = path.join(sdkRoot, "tests/storage/fixtures/premerge-m6-path-kill-probe.mjs");

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
    assert.doesNotMatch(
      processUtilsSrc,
      /if \(0\)\s*\{\s*killProcessesUsingPath\(root/,
      "path kill must not be disabled via if (0)",
    );
  });

  it("finishShutdown path-kill probe reaps cwd holder (behavioural, not source-only)", () => {
    const head = spawnSync(process.execPath, [m6Probe], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: { ...process.env, PREMERGE_MUTANT: "", IC_PREMERGE_ALLOW_MUTANT: "" },
    });
    assert.equal(head.status, 130, head.stderr || head.stdout);
    const m6 = spawnSync(process.execPath, [m6Probe], {
      cwd: sdkRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PREMERGE_MUTANT: "M6",
        IC_PREMERGE_ALLOW_MUTANT: "1",
      },
    });
    assert.equal(m6.status, 2, "M6 must leave TMPDIR holder alive (probe exit 2)");
  });
});
