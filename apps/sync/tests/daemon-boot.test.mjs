import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, afterEach } from "node:test";

import { startMockContextApi } from "./helpers/mock-api-server.mjs";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-daemon-"));
}

function daemonEnv(home, baseUrl) {
  return {
    ...process.env,
    HOME: home,
    INFINITECONTEXT_CONFIG_HOME: home,
    INFINITECONTEXT_API_KEY: "ic_test_daemon_boot_smoke",
    INFINITECONTEXT_BASE_URL: baseUrl,
    INGEST_CODEX: "true",
    INGEST_CLAUDE: "false",
    INGEST_CURSOR: "false",
    INGEST_OPENCLAW: "false",
    INGEST_GEMINI: "false",
    INGEST_GSTACK: "false",
    DAEMON_POLL_MS: "60000",
  };
}

async function waitForDaemonStarted(child, timeoutMs = 12_000) {
  const start = Date.now();
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  while (Date.now() - start < timeoutMs) {
    if (/InfiniteContext daemon started/i.test(out)) return out;
    if (child.exitCode !== null) {
      throw new Error(`daemon exited early (${child.exitCode}): ${out.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`timeout waiting for daemon start. output tail:\n${out.slice(-2000)}`);
}

describe("sync daemon boot", () => {
  /** @type {string[]} */
  const homes = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {}
    }
    try {
      execSync("node scripts/postpack-restore.mjs", { cwd: syncRoot, stdio: "pipe" });
    } catch {}
  });

  it("starts from source (index.mjs)", async () => {
    const mock = await startMockContextApi();
    const home = makeHome();
    homes.push(home);

    const child = spawn(process.execPath, [path.join(syncRoot, "src/index.mjs")], {
      env: daemonEnv(home, mock.baseUrl),
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForDaemonStarted(child);
    child.kill("SIGTERM");
    await mock.close();
  });

  it("starts from standalone packed tarball", async () => {
    execSync("pnpm run prepack", { cwd: syncRoot, stdio: "inherit" });
    const packOutput = execSync("pnpm pack --silent", { cwd: syncRoot, encoding: "utf8" }).trim();
    const tgz = path.join(syncRoot, packOutput.split("\n").pop());

    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-daemon-pack-"));
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "ic-sync-daemon-pack", private: true, type: "module" }),
    );
    execSync(`npm install --no-save --ignore-scripts --legacy-peer-deps "file:${tgz}"`, {
      cwd: installDir,
      stdio: "inherit",
    });

    const mock = await startMockContextApi();
    const home = makeHome();
    homes.push(home);

    const indexPath = path.join(installDir, "node_modules", "@infinitecontext", "sync", "src", "index.mjs");
    assert.ok(fs.existsSync(indexPath));

    const child = spawn(process.execPath, [indexPath], {
      env: daemonEnv(home, mock.baseUrl),
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForDaemonStarted(child);
    child.kill("SIGTERM");
    await mock.close();
  });
});
