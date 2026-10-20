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
  assertNoNewIcTmpDirLeaks,
  assertPremergePackageTestSections,
  assertPremergeRejectsAllowLibTestEnv,
  assertPremergeTestTotalsValid,
  infinitecontextMinPassFloor,
  isNodeVersionAtLeast,
  parseNodeVersionParts,
  parsePremergePackageCounts,
  PREMERGE_PACKAGE_MIN_PASS,
} from "../../scripts/premerge-lib.mjs";

const sdkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

describe("premerge gate helpers", () => {
  it("refuses ALLOW_LIB_TEST_ENV in premerge", () => {
    assert.throws(() => assertPremergeRejectsAllowLibTestEnv({ ALLOW_LIB_TEST_ENV: "1" }), /refuses ALLOW_LIB_TEST_ENV/);
    assert.throws(() => assertPremergeRejectsAllowLibTestEnv({ ALLOW_LIB_TEST_ENV: "true" }), /refuses ALLOW_LIB_TEST_ENV/);
    assert.doesNotThrow(() => assertPremergeRejectsAllowLibTestEnv({}));
  });

  it("uses js-sdk floor 593 without node-pty and 606 when pty loads", () => {
    assert.equal(PREMERGE_PACKAGE_MIN_PASS.infinitecontext, 593);
    assert.equal(infinitecontextMinPassFloor(false), 593);
    assert.equal(infinitecontextMinPassFloor(true), 606);
  });

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

  it("fail-closed when python-sdk 3.8 venv is unavailable (0 tests is never a pass)", () => {
    const fakePnpmOut = `
> infinitecontext-python-sdk@ test /workspace/apps/python-sdk
> node scripts/run-pytest.mjs

python-sdk: FAIL — Python 3.8 .venv is required (0 tests is never a pass). Install: uv python install 3.8
`;
    const row = parsePremergePackageCounts(fakePnpmOut).get("infinitecontext-python-sdk");
    assert.ok(row?.pythonVenvUnavailable);
    assert.throws(() => assertPremergePackageTestSections(fakePnpmOut), (err) => {
      const text = String(err);
      assert.match(text, /0 tests is never a pass/);
      assert.match(text, /Python 3\.8 .venv/);
      return true;
    });
  });

  it("detects untagged new dirs in TMPDIR leak check", () => {
    const before = new Set(["/tmp/a"]);
    const after = new Set(["/tmp/a", "/tmp/ic-untagged-leak"]);
    assert.throws(
      () => assertNoNewIcTmpDirLeaks(before, after),
      /left new temp directories/,
    );
  });

  it("reports dirs left by a leaking storage test (tagged mkdtemp outside preload tracking)", () => {
    const runTag = "ic-premerge-99999-deadbeef";
    const before = new Set([`/tmp/${runTag}-tmpdir-abc`]);
    const leakedByBadTest = `/tmp/${runTag}-storage-leak-left-behind`;
    const after = new Set([...before, leakedByBadTest]);
    assert.throws(
      () => assertNoNewIcTmpDirLeaks(before, after),
      /left new temp directories.*storage-leak-left-behind/s,
    );
  });

  it("parses pytest skipped counts", () => {
    const out = `
> infinitecontext-python-sdk@ test /workspace/apps/python-sdk
> node scripts/run-pytest.mjs

3 passed, 1 skipped in 0.01s
`;
    const row = parsePremergePackageCounts(out).get("infinitecontext-python-sdk");
    assert.equal(row?.pass, 3);
    assert.equal(row?.skipped, 1);
    assert.equal(row?.tests, 4);
  });

  it("parses pytest error counts as failures", () => {
    const out = `
> infinitecontext-python-sdk@ test /workspace/apps/python-sdk
> node scripts/run-pytest.mjs

1 error, 2 passed in 0.01s
`;
    const row = parsePremergePackageCounts(out).get("infinitecontext-python-sdk");
    assert.equal(row?.pass, 2);
    assert.equal(row?.fail, 1);
    assert.equal(row?.tests, 3);
  });

  it("parses pytest '1 failed, 2 passed' summaries", () => {
    const out = `
> infinitecontext-python-sdk@ test /workspace/apps/python-sdk
> node scripts/run-pytest.mjs

1 failed, 2 passed in 0.01s
`;
    const row = parsePremergePackageCounts(out).get("infinitecontext-python-sdk");
    assert.equal(row?.pass, 2);
    assert.equal(row?.fail, 1);
    assert.equal(row?.tests, 3);
  });

  it("requires every expected package in pnpm test output", () => {
    const partial = `
> @infinitecontext/core@0.1.0 test /workspace/packages/core
# tests 1
# pass 1
# fail 0
# skipped 0
# duration_ms 1
`;
    assert.throws(() => assertPremergePackageTestSections(partial), /missing from pnpm test output/);
  });

  it("core uses run-node-test so top-level src tests execute", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(sdkRoot, "../../packages/core/package.json"), "utf8"),
    );
    assert.match(pkg.scripts.test, /run-node-test\.mjs/);
    assert.match(pkg.scripts.test, /src\/\*\*\/\*\.test\.ts/);
  });
});

