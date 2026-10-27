import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
const patchDir = path.join(sdkRoot, "tests/fixtures/committed-mutants");

/** @type {{ id: string, patch: string, testRel: string }[]} */
const CASES = [
  { id: "S-M3", patch: "sm3.patch", testRel: "apps/js-sdk/scripts/premerge-shutdown-m3-latch.test.mjs" },
  {
    id: "S-M6",
    patch: "sm6.patch",
    testRel: "apps/js-sdk/scripts/premerge-shutdown.test.mjs",
    filter: "SIGINT during late-writer leg removes TMPDIR",
  },
  {
    id: "O1",
    patch: "o1-b1-revert.patch",
    testRel: "apps/js-sdk/scripts/premerge-b1-offset-probe.test.mjs",
    filter: "head: exit 130 for probe offsets",
  },
  {
    id: "S-M7",
    patch: "sm7.patch",
    testRel: "apps/js-sdk/scripts/premerge-shutdown-group-kill.test.mjs",
    filter: "terminateActiveLeg sends kill",
  },
];

/**
 * @param {string} patchName
 * @param {string} testRel
 * @param {string | undefined} nameFilter
 */
function runInCommittedMutantWorktree(patchName, testRel, nameFilter) {
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-wt-"));
  const branch = `cursor/mutant-${patchName.replace(/\.patch$/, "")}-ee80-${Date.now()}`;
  const add = spawnSync("git", ["worktree", "add", "-B", branch, wtRoot, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr || add.stdout);

  try {
    const patchPath = path.join(patchDir, patchName);
    const apply = spawnSync("git", ["apply", patchPath], { cwd: wtRoot, encoding: "utf8" });
    assert.equal(apply.status, 0, apply.stderr || apply.stdout);
    const commit = spawnSync("git", ["commit", "-am", `test: committed mutant ${patchName}`], {
      cwd: wtRoot,
      encoding: "utf8",
    });
    assert.equal(commit.status, 0, commit.stderr || commit.stdout);

    const testFile = path.join(wtRoot, testRel);
    const args = [process.execPath, "--test", testFile];
    if (nameFilter) {
      args.push("--test-name-pattern", nameFilter);
    }
    const run = spawnSync(args[0], args.slice(1), {
      cwd: path.join(wtRoot, "apps/js-sdk"),
      encoding: "utf8",
      env: { ...process.env },
    });
    const combined = `${run.stdout}\n${run.stderr}`;
    assert.match(combined, /# tests \d+/, "expected test file to execute in worktree");
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, wtRoot, branch };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wtRoot], { cwd: repoRoot });
    spawnSync("git", ["branch", "-D", branch], { cwd: repoRoot });
  }
}

describe("committed source mutants (clean tree)", () => {
  for (const c of CASES) {
    it(`${c.id}: regression test fails on committed mutant branch`, () => {
      const res = runInCommittedMutantWorktree(c.patch, c.testRel, c.filter);
      assert.notEqual(
        res.status,
        0,
        `expected failure on mutant; stdout=${res.stdout}\nstderr=${res.stderr}`,
      );
    });
  }
});
