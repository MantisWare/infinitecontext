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
    assert.match(
      String(res.stderr ?? res.stdout),
      /no origin remote and no origin\/main|could not resolve main snapshot/,
    );
  });

  it("uses three-dot diff when merge base exists (feature branched from main)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-guard-3dot-"));
    const localGuard = copyGuard(tmp);
    spawnSync("git", ["init", "-b", "main"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README.md"), "main\n");
    spawnSync("git", ["add", "README.md"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "main"], { cwd: tmp });
    const mainSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", mainSha], { cwd: tmp });
    spawnSync("git", ["checkout", "-b", "feature"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "safe.txt"), "ok\n");
    spawnSync("git", ["add", "safe.txt"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "safe change"], { cwd: tmp });

    const res = spawnSync("bash", [localGuard], { cwd: tmp, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(String(res.stderr ?? ""), /three-dot diff/);
    assert.match(String(res.stdout ?? ""), /ok/);
  });

  it("blocks #12 paths using two-dot diff when no merge base (orphan feature)", () => {
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
    assert.match(String(res.stderr ?? res.stdout), /two-dot diff|no merge base/);
    assert.match(String(res.stderr ?? res.stdout), /BLOCKED/);
    assert.match(String(res.stderr ?? res.stdout), /contexts\.ts/);
  });
});
