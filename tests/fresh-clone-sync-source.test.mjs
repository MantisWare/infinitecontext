/**
 * Simulates fresh clone: workspace #parsers imports (no parsers-bundle), build, infinitecontext sync from source.
 */
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, afterEach } from "node:test";

import { startMockContextApi } from "../apps/sync/tests/helpers/mock-api-server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncRoot = path.join(repoRoot, "apps/sync");
const cliEntry = path.join(repoRoot, "apps/js-sdk/src/cli/entry.mjs");
const parsersBundle = path.join(syncRoot, "src/parsers-bundle");

describe("fresh clone sync from source", () => {
  /** @type {string[]} */
  const homes = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it("runs infinitecontext sync after install+build without parsers-bundle", async () => {
    if (fs.existsSync(parsersBundle)) {
      fs.rmSync(parsersBundle, { recursive: true, force: true });
    }

    execSync("pnpm install", { cwd: repoRoot, stdio: "inherit" });
    execSync("pnpm -r --if-present run build", { cwd: repoRoot, stdio: "inherit" });

    assert.equal(fs.existsSync(parsersBundle), false);
    execSync("node --check src/daemon.mjs", { cwd: syncRoot, stdio: "inherit" });

    const mock = await startMockContextApi();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fresh-clone-"));
    homes.push(home);
    const icDir = path.join(home, ".infinitecontext");
    fs.mkdirSync(icDir, { recursive: true });
    fs.writeFileSync(
      path.join(icDir, "config.json"),
      `${JSON.stringify({ apiKey: "ic_test_fresh_clone_sync", baseUrl: mock.baseUrl }, null, 2)}\n`,
    );

    const child = spawn(process.execPath, [cliEntry, "sync", "start"], {
      env: {
        ...process.env,
        HOME: home,
        INFINITECONTEXT_CONFIG_HOME: home,
        INFINITECONTEXT_API_KEY: "ic_test_fresh_clone_sync",
        INFINITECONTEXT_BASE_URL: mock.baseUrl,
        INGEST_CODEX: "true",
        INGEST_CLAUDE: "false",
        INGEST_CURSOR: "false",
        INGEST_OPENCLAW: "false",
        INGEST_GEMINI: "false",
        INGEST_GSTACK: "false",
        INFINITECONTEXT_NO_UPDATE_CHECK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });

    const deadline = Date.now() + 20_000;
    let lockSeen = false;
    while (Date.now() < deadline) {
      const lockPath = path.join(home, ".infinitecontext", "daemon.lock");
      if (fs.existsSync(lockPath)) {
        lockSeen = true;
        break;
      }
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`sync start failed (${child.exitCode}): ${out.slice(-2000)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(lockSeen, `expected daemon lock file; output tail:\n${out.slice(-1500)}`);

    try {
      execSync(`node ${cliEntry} sync stop`, {
        env: { ...process.env, HOME: home, INFINITECONTEXT_CONFIG_HOME: home },
        stdio: "inherit",
      });
    } finally {
      await mock.close();
    }
  });
});
