import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  collectLegProcessPids,
  killProcessesUsingPath,
  listChildPids,
  removePrivateTmpDirVerified,
} from "./premerge-process-utils.mjs";

describe("premerge-process-utils", () => {
  it("listChildPids includes direct children", () => {
    const children = listChildPids(process.pid);
    assert.ok(Array.isArray(children));
  });

  it("killProcessesUsingPath targets processes under TMPDIR", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-killpath-"));
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    killProcessesUsingPath(root, "SIGKILL");
    assert.equal(fs.existsSync(root), true);
  });

  it("removePrivateTmpDirVerified removes empty dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ic-rm-verify-"));
    assert.equal(removePrivateTmpDirVerified(root), true);
    assert.equal(fs.existsSync(root), false);
  });

  it("collectLegProcessPids unions tree and group", () => {
    const pids = collectLegProcessPids(process.pid, process.pid);
    assert.ok(Array.isArray(pids));
  });
});
