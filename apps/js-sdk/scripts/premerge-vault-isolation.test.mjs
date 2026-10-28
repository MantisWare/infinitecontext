import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { infinitecontextHome } from "../lib/credentials.mjs";
import { syncVaultAgentCleanup, listVaultAgentServePidsForHome } from "./premerge-vault-cleanup.mjs";
import { registerPremergeVaultAgentPid } from "../lib/premerge-vault-registry.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serveScript = path.join(sdkRoot, "lib/vault-agent-serve.mjs");
const otherScript = path.join(
  sdkRoot,
  "tests/storage/fixtures/vault-agent-serve-other-project.mjs",
);

/**
 * @param {string} home
 * @param {string} script
 */
function spawnDetachedAgent(home, script) {
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOME: home },
  });
  child.unref();
  return child.pid;
}

function agentRuntimePaths(home) {
  const ic = path.join(home, ".infinitecontext");
  return {
    sock: path.join(ic, "vault-agent.sock"),
    pid: path.join(ic, "vault-agent.pid"),
  };
}

describe("premerge vault-agent cleanup isolation", () => {
  it("syncVaultAgentCleanup kills only premerge HOME agents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-vault-iso-"));
    const premergeHome = path.join(root, "premerge-home");
    const devHome = path.join(root, "devhome");
    const otherHome = path.join(root, "otherhome");
    /** @type {number[]} */
    const spawnedPids = [];
    try {
      for (const h of [premergeHome, devHome, otherHome]) {
        fs.mkdirSync(h, { recursive: true });
      }

      const devPid = spawnDetachedAgent(devHome, serveScript);
      const otherPid = spawnDetachedAgent(otherHome, otherScript);
      const premergePid = spawnDetachedAgent(premergeHome, serveScript);
      spawnedPids.push(devPid, otherPid, premergePid);
      assert.ok(devPid && otherPid && premergePid);

      await new Promise((r) => setTimeout(r, 400));

      const registry = path.join(root, "vault-pids.txt");
      registerPremergeVaultAgentPid(registry, premergePid);

      syncVaultAgentCleanup({
        sdkRoot,
        premergeHome,
        vaultPidRegistryPath: registry,
      });
      await new Promise((r) => setTimeout(r, 300));

      assert.equal(listVaultAgentServePidsForHome(premergeHome).length, 0);
      assert.ok(listVaultAgentServePidsForHome(devHome).length > 0);
      assert.ok(listVaultAgentServePidsForHome(otherHome).length > 0);

      const devPaths = agentRuntimePaths(devHome);
      const otherPaths = agentRuntimePaths(otherHome);
      assert.ok(fs.existsSync(devPaths.sock) || fs.existsSync(devPaths.pid));
      assert.ok(fs.existsSync(otherPaths.sock) || fs.existsSync(otherPaths.pid));
    } finally {
      for (const pid of spawnedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 200));
      for (const pid of spawnedPids) {
        try {
          process.kill(pid, 0);
          assert.fail(`expected vault-agent pid ${pid} to be dead after test cleanup`);
        } catch (err) {
          assert.ok(err && typeof err === "object" && "code" in err && err.code === "ESRCH");
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never reads the developer real ~/.infinitecontext", () => {
    const realIcDir = path.join(os.homedir(), ".infinitecontext");
    fs.mkdirSync(realIcDir, { recursive: true });
    const sentinel = path.join(realIcDir, "ic-premerge-no-read-sentinel");
    fs.writeFileSync(sentinel, `probe-${process.pid}-${Date.now()}\n`);
    const before = fs.statSync(sentinel).mtimeMs;

    const fakePremergeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fake-premerge-home-"));
    try {
      const pids = listVaultAgentServePidsForHome(fakePremergeHome);
      assert.ok(Array.isArray(pids));
      assert.notEqual(path.resolve(infinitecontextHome()), path.resolve(fakePremergeHome));
      syncVaultAgentCleanup({
        sdkRoot,
        premergeHome: fakePremergeHome,
        vaultPidRegistryPath: path.join(fakePremergeHome, "empty-registry.txt"),
      });
      const after = fs.statSync(sentinel).mtimeMs;
      assert.equal(after, before, "real ~/.infinitecontext sentinel must not be touched");
    } finally {
      fs.rmSync(fakePremergeHome, { recursive: true, force: true });
      try {
        fs.unlinkSync(sentinel);
      } catch {
        /* ignore */
      }
    }
  });
});
