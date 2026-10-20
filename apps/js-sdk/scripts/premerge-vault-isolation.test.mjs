import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { infinitecontextHome } from "../lib/credentials.mjs";
import { syncVaultAgentCleanup, listVaultAgentServePidsForHome } from "./premerge-vault-cleanup.mjs";
import { registerPremergeVaultAgentPid } from "./premerge-vault-registry.mjs";

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
    for (const h of [premergeHome, devHome, otherHome]) {
      fs.mkdirSync(h, { recursive: true });
    }

    const devPid = spawnDetachedAgent(devHome, serveScript);
    const otherPid = spawnDetachedAgent(otherHome, otherScript);
    const premergePid = spawnDetachedAgent(premergeHome, serveScript);
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

    for (const pid of [devPid, otherPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  });

  it("never reads the developer real ~/.infinitecontext", () => {
    const realHome = path.join(os.homedir(), ".infinitecontext");
    const fakePremergeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fake-premerge-home-"));
    const pids = listVaultAgentServePidsForHome(fakePremergeHome);
    assert.ok(Array.isArray(pids));
    assert.notEqual(path.resolve(infinitecontextHome()), path.resolve(fakePremergeHome));
    if (fs.existsSync(realHome)) {
      assert.ok(fs.statSync(realHome).isDirectory());
    }
  });
});
