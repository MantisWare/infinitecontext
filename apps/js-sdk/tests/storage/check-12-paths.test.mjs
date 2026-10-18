import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const guardScript = path.resolve(import.meta.dirname, "../../../../scripts/check-12-paths.sh");

function copyGuard(tmp) {
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.copyFileSync(guardScript, path.join(tmp, "scripts/check-12-paths.sh"));
  return path.join(tmp, "scripts/check-12-paths.sh");
}

describe("check-12-paths guard", () => {
  it("fails when no origin/main or main base ref exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-guard-nobase-"));
    const localGuard = copyGuard(tmp);
    spawnSync("git", ["init", "-b", "work"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README.md"), "x\n");
    spawnSync("git", ["add", "README.md"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmp });

    const res = spawnSync("bash", [localGuard], { cwd: tmp, encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(String(res.stderr ?? res.stdout), /no resolvable base ref|could not resolve main snapshot/);
  });

  it("blocks #12 paths using two-dot diff vs origin/main (no merge base required)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-guard-block-"));
    const localGuard = copyGuard(tmp);
    spawnSync("git", ["init", "-b", "main"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README.md"), "main\n");
    spawnSync("git", ["add", "README.md"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "main"], { cwd: tmp });
    const mainSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", mainSha], { cwd: tmp });
    spawnSync("git", ["checkout", "--orphan", "feature"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README.md"), "feature\n");
    spawnSync("git", ["add", "README.md"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "feature"], { cwd: tmp });
    fs.mkdirSync(path.join(tmp, "apps/api/src/routes"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "apps/api/src/routes/contexts.ts"), "// blocked\n");
    spawnSync("git", ["add", "apps/api/src/routes/contexts.ts"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "touch blocked"], { cwd: tmp });

    const res = spawnSync("bash", [localGuard], { cwd: tmp, encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(String(res.stderr ?? res.stdout), /BLOCKED/);
    assert.match(String(res.stderr ?? res.stdout), /contexts\.ts/);
  });
});
