import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = path.join(repoRoot, "scripts/ic-test-tmp-preload.mjs");

describe("ic-test-tmp-preload", () => {
  it("does not delete pre-existing tag dirs on exit", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-preload-survival-"));
    const tag = "TAGX-survival";
    const injected = path.join(tmp, `${tag}-injected`);
    fs.mkdirSync(injected, { recursive: true });
    fs.writeFileSync(path.join(injected, "marker"), "keep");

    const res = spawnSync(
      process.execPath,
      ["--import", preload, "-e", "process.exit(0)"],
      {
        env: { ...process.env, TMPDIR: tmp, IC_TEST_TMP_RUN_TAG: tag },
        encoding: "utf8",
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(injected, "marker")), "pre-existing tagged dir must survive preload exit");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
