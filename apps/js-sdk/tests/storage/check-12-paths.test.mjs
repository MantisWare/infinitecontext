import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const guardScript = path.resolve(import.meta.dirname, "../../../../scripts/check-12-paths.sh");

describe("check-12-paths guard", () => {
  it("fails when no origin/main or main base ref exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-guard-nobase-"));
    fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    fs.copyFileSync(guardScript, path.join(tmp, "scripts/check-12-paths.sh"));
    spawnSync("git", ["init", "-b", "work"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README.md"), "x\n");
    spawnSync("git", ["add", "README.md"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmp });

    const localGuard = path.join(tmp, "scripts/check-12-paths.sh");
    const res = spawnSync("bash", [localGuard], { cwd: tmp, encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(String(res.stderr ?? res.stdout), /no resolvable base ref/);
  });
});
