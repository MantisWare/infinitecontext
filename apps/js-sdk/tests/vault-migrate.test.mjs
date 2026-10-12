import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import {
  loadMigrateState,
  migrateProjectEncryption,
  saveMigrateState,
} from "../lib/vault-migrate.mjs";

describe("vault migrate-project", () => {
  /** @type {string} */
  let prevHome;

  before(() => {
    prevHome = process.env.HOME;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ic-migrate-"));
  });

  after(() => {
    process.env.HOME = prevHome;
  });

  it("dry-run lists pending contexts without mutating state", async () => {
    const calls = [];
    const report = await migrateProjectEncryption({
      scopeKey: "usr_test",
      dryRun: true,
      listContexts: async () => ({ data: [{ id: "ctx_a" }, { id: "ctx_b" }] }),
      encryptContext: async (id) => {
        calls.push(id);
        return { encrypted: true };
      },
    });
    assert.deepEqual(report.pending, ["ctx_a", "ctx_b"]);
    assert.equal(calls.length, 0);
    assert.deepEqual(loadMigrateState("usr_test").completedContextIds, []);
  });

  it("resumes and persists completed context ids", async () => {
    saveMigrateState("usr_resume", { completedContextIds: ["ctx_done"] });
    const encrypted = [];
    const report = await migrateProjectEncryption({
      scopeKey: "usr_resume",
      dryRun: false,
      listContexts: async () => ({ data: [{ id: "ctx_done" }, { id: "ctx_new" }] }),
      encryptContext: async (id) => {
        encrypted.push(id);
        return { encrypted: true };
      },
    });
    assert.deepEqual(encrypted, ["ctx_new"]);
    assert.deepEqual(report.completed.sort(), ["ctx_done", "ctx_new"].sort());
  });
});
