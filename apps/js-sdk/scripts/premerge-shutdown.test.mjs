import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { removePrivateTmpDirVerified } from "./premerge-process-utils.mjs";
import { syncVaultAgentCleanup, listVaultAgentServePidsForHome } from "./premerge-vault-cleanup.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lateWriterLeg = path.join(
  sdkRoot,
  "tests/storage/fixtures/premerge-late-writer-leg.mjs",
);
const sigintDuringCleanup = path.join(
  sdkRoot,
  "tests/storage/fixtures/premerge-sigint-during-cleanup.mjs",
);
describe("premerge shutdown helpers", () => {
  it("removePrivateTmpDirVerified returns true when path is already gone", () => {
    const root = path.join(os.tmpdir(), `ic-tmp-missing-${Date.now()}`);
    assert.equal(removePrivateTmpDirVerified(root), true);
  });

  it("SIGINT during slow post-failure cleanup exits 130 not 1", async () => {
    const child = spawn(process.execPath, [sigintDuringCleanup], {
      cwd: sdkRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const onData = (c) => {
        buf += String(c);
        if (buf.includes("CLEANUP_STARTED")) {
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const poll = () => {
        if (Date.now() > deadline) {
          reject(new Error("cleanup marker timeout"));
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    child.kill("SIGINT");
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 130);
  });

  it("syncVaultAgentCleanup scoped to premerge HOME only", async () => {
    const premergeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ic-shutdown-vault-home-"));
    const serve = path.join(sdkRoot, "lib/vault-agent-serve.mjs");
    const child = spawn(process.execPath, [serve], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: premergeHome, IC_PREMERGE_HOME: premergeHome },
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(listVaultAgentServePidsForHome(premergeHome).length > 0);
    syncVaultAgentCleanup({ sdkRoot, premergeHome });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(listVaultAgentServePidsForHome(premergeHome).length, 0);
    fs.rmSync(premergeHome, { recursive: true, force: true });
  });

  it("SIGINT during late-writer leg removes TMPDIR and exits 130", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-shutdown-late-"));
    const child = spawn(process.execPath, [lateWriterLeg], {
      cwd: sdkRoot,
      env: { ...process.env, IC_PREMERGE_TMPDIR: tmpRoot, TMPDIR: tmpRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const onData = (chunk) => {
        buf += String(chunk);
        if (buf.includes("LATE_WRITER_LEG_READY")) {
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", reject);
      const poll = () => {
        if (buf.includes("LATE_WRITER_LEG_READY")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("late writer leg not ready"));
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    child.kill("SIGINT");
    const code = await new Promise((resolve) => {
      child.on("exit", (status) => resolve(status));
    });
    assert.equal(code, 130);
    assert.equal(fs.existsSync(tmpRoot), false);
  });
});
