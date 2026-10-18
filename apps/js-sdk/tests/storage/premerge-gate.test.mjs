import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PREMERGE_MIN_NODE,
  absorbNodeTestTotals,
  assertExpectedShaMatchesHead,
  assertGitTreeClean,
  assertPremergeTestTotalsValid,
  isNodeVersionAtLeast,
  parseNodeVersionParts,
} from "../../scripts/premerge-lib.mjs";

describe("premerge gate helpers", () => {
  it("requires Node >=22.12", () => {
    assert.equal(isNodeVersionAtLeast([22, 12, 0], PREMERGE_MIN_NODE), true);
    assert.equal(isNodeVersionAtLeast([22, 11, 9], PREMERGE_MIN_NODE), false);
    assert.deepEqual(parseNodeVersionParts("v22.14.0"), [22, 14, 0]);
  });

  it("EXPECTED_SHA must be full 40-hex and match HEAD", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-premerge-git-"));
    spawnSync("git", ["init"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "f.txt"), "x\n");
    spawnSync("git", ["add", "f.txt"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmp });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    assert.throws(() => assertExpectedShaMatchesHead(tmp, "abc"), /40-character/);
    assert.throws(
      () => assertExpectedShaMatchesHead(tmp, head.toUpperCase()),
      /lowercase hex/,
    );
    assert.equal(assertExpectedShaMatchesHead(tmp, head), head);
  });

  it("refuses dirty git tree", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-premerge-dirty-"));
    spawnSync("git", ["init"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "clean.txt"), "a\n");
    spawnSync("git", ["add", "clean.txt"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "c"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "dirty.txt"), "b\n");
    assert.throws(() => assertGitTreeClean(tmp), /dirty working tree/);
  });

  it("absorbs node test reporter totals from summary blocks only", () => {
    const noisy =
      "# pass 99\n# tests 3\n# suites 1\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 12\n";
    const totals = absorbNodeTestTotals(noisy);
    assert.deepEqual(
      { pass: totals.pass, fail: totals.fail, skipped: totals.skipped, tests: totals.tests, blocks: totals.blocks },
      { pass: 2, fail: 0, skipped: 1, tests: 3, blocks: 1 },
    );
    assert.doesNotThrow(() => assertPremergeTestTotalsValid(totals));
  });

  it("refuses empty or unparseable test output", () => {
    assert.throws(() => assertPremergeTestTotalsValid(absorbNodeTestTotals("")), /false-green/);
  });
});

