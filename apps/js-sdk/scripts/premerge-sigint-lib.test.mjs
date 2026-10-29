import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  loadPostgresPassword,
  parsePremergeHomeFromLog,
  parsePremergeNodePidFromLog,
  parsePremergeTmpDirFromLog,
  resolvePremergeSigintSdkRoot,
  runPremergeSigintOnce,
} from "./premerge-sigint-lib.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");

/**
 * @param {string} root
 */
function loadPasswordOrDummy(root) {
  try {
    return loadPostgresPassword(root);
  } catch {
    return "premerge-sigint-lib-test-dummy";
  }
}

function countActiveTimeoutResources() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

/** @param {() => Promise<void>} run */
async function runSigintSpawnIntegrationCase(run) {
  const head = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const password = loadPasswordOrDummy(repoRoot);
  await withScrubbedSigintCallerEnv(async () => {
    const cwd = process.cwd();
    assert.notEqual(cwd, repoRoot, "caller cwd must not be repo root");
    assert.notEqual(cwd, sdkRoot, "caller cwd must not be js-sdk root");
    assert.equal(process.env.EXPECTED_SHA, undefined, "caller env must not inherit EXPECTED_SHA");
    assert.deepEqual(Object.keys(process.env).sort(), ["HOME", "IC_PREMERGE_SIGINT_DOCKER_WRAP", "PATH"]);
    await run({ head, password });
  });
}

/**
 * env -i style caller: minimal PATH/HOME only, no inherited EXPECTED_SHA, cwd outside repo/sdk.
 * @param {() => Promise<void>} run
 */
async function withScrubbedSigintCallerEnv(run) {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sigint-spawn-home-"));
  const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sigint-spawn-cwd-"));
  const pathEnv = savedEnv.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  process.env = {
    PATH: pathEnv,
    HOME: scratchHome,
    IC_PREMERGE_SIGINT_DOCKER_WRAP: "",
  };
  process.chdir(scratchCwd);
  try {
    await run();
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
    fs.rmSync(scratchHome, { recursive: true, force: true });
    fs.rmSync(scratchCwd, { recursive: true, force: true });
  }
}

describe("premerge sigint lib", () => {
  it("parses node pid and TMPDIR from premerge banner lines", () => {
    const log = `premerge: private TMPDIR=/tmp/ic-premerge-1-abc-tmpdir-x
premerge: isolated HOME=/tmp/ic-premerge-1-abc-tmpdir-x/home-y
premerge: node pid=4242
`;
    assert.equal(parsePremergeNodePidFromLog(log), 4242);
    assert.equal(parsePremergeTmpDirFromLog(log), "/tmp/ic-premerge-1-abc-tmpdir-x");
    assert.equal(parsePremergeHomeFromLog(log), "/tmp/ic-premerge-1-abc-tmpdir-x/home-y");
  });

  it("resolvePremergeSigintSdkRoot follows the lib file location, not /workspace", () => {
    const workspaceSdk = path.resolve("/workspace/apps/js-sdk");
    const localRoot = resolvePremergeSigintSdkRoot(import.meta.url);
    assert.equal(localRoot, path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sigint-lib-wt-"));
    const wtPath = path.join(wtParent, "wt");
    const wtRepoRoot = path.resolve(localRoot, "../..");
    try {
      execSync(`git worktree add --detach ${JSON.stringify(wtPath)} HEAD`, {
        cwd: wtRepoRoot,
        stdio: "pipe",
      });
      const wtLib = path.join(wtPath, "apps/js-sdk/scripts/premerge-sigint-lib.mjs");
      assert.ok(fs.existsSync(wtLib), "worktree must contain premerge-sigint-lib.mjs");
      const wtSdk = resolvePremergeSigintSdkRoot(pathToFileURL(wtLib).href);
      const wtSdkNorm = path.resolve(wtSdk);
      assert.ok(
        wtSdkNorm.startsWith(path.resolve(wtPath) + path.sep),
        `worktree sdk root must live under worktree (${wtSdkNorm} vs ${wtPath})`,
      );
      if (localRoot === workspaceSdk && wtPath !== "/workspace") {
        assert.notEqual(
          wtSdkNorm,
          workspaceSdk,
          "worktree copy must not resolve to hardcoded /workspace/apps/js-sdk",
        );
      }
    } finally {
      try {
        execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
          cwd: wtRepoRoot,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
      fs.rmSync(wtParent, { recursive: true, force: true });
    }
  });

  it("runPremergeSigintOnce spawn path uses lib cwd and inner EXPECTED_SHA under scrubbed caller env", async () => {
    await runSigintSpawnIntegrationCase(async ({ head, password }) => {
      const row = await runPremergeSigintOnce({
        category: "early",
        label: "scrubbed-caller-env",
        pattern: /check-12-paths|guard:12/,
        head,
        password,
        extraEnv: {
          IC_PREMERGE_ALLOW_DIRTY: "1",
        },
      });
      assert.equal(row.hit, 1, "must reach post-EXPECTED_SHA guard leg (guard:12 marker)");
      assert.equal(row.code, 130, "SIGINT during guard leg must exit 130");
    });
  });

  it("runPremergeSigintOnce SIGKILLs shell child when race timeout elapses", async () => {
    const savedRaceMs = process.env.IC_PREMERGE_SIGINT_RACE_TIMEOUT_MS;
    const savedWrap = process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP;
    process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP = "";
    try {
      await runSigintSpawnIntegrationCase(async () => {
        process.env.IC_PREMERGE_SIGINT_RACE_TIMEOUT_MS = "150";
        const row = await runPremergeSigintOnce({
          category: "early",
          label: "race-sigkill",
          pattern: /ic-premerge-sigint-never-match/,
          head: "0".repeat(40),
          password: "unused",
          testInnerShell: "sleep 120",
        });
        assert.equal(row.code, 124, "race timeout must resolve 124");
        assert.equal(row.shellExitSignal, "SIGKILL", "shell child must exit from SIGKILL");
        assert.equal(row.shellAliveAfterRace, 0, "shell child must not survive race timeout");
        assert.equal(
          row.raceKillChildMarkedKilled,
          true,
          "race kill must use ChildProcess.kill (child.killed)",
        );
      });
    } finally {
      if (savedRaceMs === undefined) {
        delete process.env.IC_PREMERGE_SIGINT_RACE_TIMEOUT_MS;
      } else {
        process.env.IC_PREMERGE_SIGINT_RACE_TIMEOUT_MS = savedRaceMs;
      }
      if (savedWrap === undefined) {
        delete process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP;
      } else {
        process.env.IC_PREMERGE_SIGINT_DOCKER_WRAP = savedWrap;
      }
    }
  });

  it("runPremergeSigintOnce clears SIGINT race timeout when child exits", async () => {
    const before = countActiveTimeoutResources();
    await runSigintSpawnIntegrationCase(async ({ head, password }) => {
      await runPremergeSigintOnce({
        category: "early",
        label: "race-timeout-cleanup",
        pattern: /check-12-paths|guard:12/,
        head,
        password,
        extraEnv: {
          IC_PREMERGE_ALLOW_DIRTY: "1",
        },
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    const after = countActiveTimeoutResources();
    assert.equal(
      after,
      before,
      "must not leave active Timeout handle after runPremergeSigintOnce settles",
    );
  });
});
