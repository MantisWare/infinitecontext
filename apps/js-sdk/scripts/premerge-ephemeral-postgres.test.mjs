import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  listIcPremergeDockerResources,
  startEphemeralPostgresForPremerge,
  tearDownEphemeralPostgresProject,
} from "./premerge-ephemeral-postgres.mjs";
import { parsePremergeNodePidFromLog } from "./premerge-sigint-lib.mjs";
import { loadPostgresPassword } from "./premerge-sigint-lib.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");

describe("premerge ephemeral Postgres docker hygiene", () => {
  it("listIcPremergeDockerResources returns arrays", () => {
    const row = listIcPremergeDockerResources();
    assert.ok(Array.isArray(row.containers));
    assert.ok(Array.isArray(row.networks));
    assert.ok(Array.isArray(row.volumes));
  });

  it("tearDownEphemeralPostgresProject is scoped to compose project name", () => {
    const down = tearDownEphemeralPostgresProject(repoRoot, "ic_premerge_pg_99999_testonly", process.env);
    assert.equal(
      down.status,
      0,
      `tearDownEphemeralPostgresProject must succeed (got ${down.status}): ${down.stderr || down.stdout}`,
    );
  });

  it("SIGINT after ephemeral Postgres start leaves no ic_premerge docker (live)", async () => {
    if (process.env.IC_PREMERGE_LIVE_DOCKER !== "1") {
      return;
    }
    let password;
    try {
      password = loadPostgresPassword(repoRoot);
    } catch {
      return;
    }
    const head = spawn("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    const headOut = await new Promise((resolve, reject) => {
      let buf = "";
      head.stdout.on("data", (c) => {
        buf += c;
      });
      head.on("exit", (c) => (c === 0 ? resolve(buf.trim()) : reject(new Error("git"))));
    });

    const inner = [
      "cd /workspace/apps/js-sdk",
      [
        "PREMERGE_MUTANT=",
        `EXPECTED_SHA=${headOut}`,
        `POSTGRES_PASSWORD=${password}`,
        "node scripts/premerge.mjs",
      ].join(" "),
    ].join(" && ");

    const child = spawn("bash", ["-lc", `sg docker -c ${JSON.stringify(inner)}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const on = (c) => {
      log += c;
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);

    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 300_000;
      const tick = () => {
        const pid = parsePremergeNodePidFromLog(log);
        if (/ephemeral Postgres project=/.test(log) && pid !== null) {
          resolve(undefined);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("timeout waiting for ephemeral Postgres"));
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });

    const pid = parsePremergeNodePidFromLog(log);
    assert.ok(pid && pid > 0);
    process.kill(pid, "SIGINT");
    await new Promise((resolve) => child.on("exit", resolve));

    await new Promise((r) => setTimeout(r, 2000));
    const left = listIcPremergeDockerResources();
    assert.equal(left.count, 0, `leftover docker: ${JSON.stringify(left)}`);
  });

  it("startEphemeralPostgres cleanup() removes ic_premerge project (live)", () => {
    if (process.env.IC_PREMERGE_LIVE_DOCKER !== "1") {
      return;
    }
    const probe = spawn("docker", ["info"], { stdio: "ignore" });
    if (probe.status !== 0) {
      return;
    }
    const password = loadPostgresPassword(repoRoot);
    process.env.POSTGRES_PASSWORD = password;
    const pg = startEphemeralPostgresForPremerge(repoRoot, process.env);
    assert.ok(pg.project.includes("ic_premerge_pg_"));
    pg.cleanup();
    const left = listIcPremergeDockerResources();
    assert.equal(left.count, 0, JSON.stringify(left));
  });
});
