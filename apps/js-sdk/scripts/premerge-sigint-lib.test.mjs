import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  parsePremergeHomeFromLog,
  parsePremergeNodePidFromLog,
  parsePremergeTmpDirFromLog,
  resolvePremergeSigintSdkRoot,
} from "./premerge-sigint-lib.mjs";

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
    assert.equal(localRoot, path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."));

    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sigint-lib-wt-"));
    const wtPath = path.join(wtParent, "wt");
    const repoRoot = path.resolve(localRoot, "../..");
    try {
      execSync(`git worktree add --detach ${JSON.stringify(wtPath)} HEAD`, {
        cwd: repoRoot,
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
          cwd: repoRoot,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
      fs.rmSync(wtParent, { recursive: true, force: true });
    }
  });
});
