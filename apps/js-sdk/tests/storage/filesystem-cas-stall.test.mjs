import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { sampleEncryptedObjectBytesForKey } from "../../lib/storage/contract-suite.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

const STALL_MS = 12_000;
const WORKER = fileURLToPath(new URL("./filesystem-object-stall-worker.mjs", import.meta.url));

/** @param {string[]} args */
function runWorker(args) {
  return new Promise((resolve, reject) => {
    /** @type {string[]} */
    const lines = [];
    const child = spawn(process.execPath, args, { env: process.env });
    child.stdout.on("data", (c) => lines.push(String(c)));
    child.stderr.on("data", (c) => lines.push(String(c)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, out: lines.join("") }));
  });
}

describe("Filesystem object generation CAS stall before link", () => {
  it("ifNoneMatch create survives stall", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-stall-create-"));
    const res = await runWorker([WORKER, rootDir, "create", String(STALL_MS)]);
    assert.match(res.out, /STALL_OK create/);
    assert.equal(res.code, 0);
    const reader = createFilesystemStorageAdapter({ rootDir });
    await reader.init();
    assert.ok(await reader.get("stall/object.enc"));
    console.log("IC_FS_STALL_CREATE: exit=0 object_present=true");
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("ifMatch update survives stall", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-stall-update-"));
    const seed = createFilesystemStorageAdapter({ rootDir });
    await seed.init();
    await seed.put("stall/object.enc", sampleEncryptedObjectBytesForKey("stall/object.enc"), {
      ifNoneMatch: "*",
    });
    await seed.close();

    const res = await runWorker([WORKER, rootDir, "update", String(STALL_MS)]);
    assert.match(res.out, /STALL_OK update/);
    assert.equal(res.code, 0);
    console.log("IC_FS_STALL_UPDATE: exit=0");
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("delete survives stall", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-stall-delete-"));
    const seed = createFilesystemStorageAdapter({ rootDir });
    await seed.init();
    await seed.put("stall/object.enc", sampleEncryptedObjectBytesForKey("stall/object.enc"), {
      ifNoneMatch: "*",
    });
    await seed.close();

    const res = await runWorker([WORKER, rootDir, "delete", String(STALL_MS)]);
    assert.match(res.out, /STALL_OK delete/);
    assert.equal(res.code, 0);
    const reader = createFilesystemStorageAdapter({ rootDir });
    await reader.init();
    assert.equal(await reader.get("stall/object.enc"), null);
    console.log("IC_FS_STALL_DELETE: exit=0 object_absent=true");
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

});
