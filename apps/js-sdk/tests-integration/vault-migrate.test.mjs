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

  it("continues after per-context failures and reports failed ids", async () => {
    const report = await migrateProjectEncryption({
      scopeKey: "usr_fail",
      dryRun: false,
      listContexts: async () => ({ data: [{ id: "ctx_ok" }, { id: "ctx_bad" }, { id: "ctx_ok2" }] }),
      encryptContext: async (id) => {
        if (id === "ctx_bad") throw new Error("simulated migrate failure");
        return { encrypted: true };
      },
    });
    assert.deepEqual(report.encryptedThisRun.sort(), ["ctx_ok", "ctx_ok2"].sort());
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].id, "ctx_bad");
    assert.equal(report.ok, false);
  });
});
