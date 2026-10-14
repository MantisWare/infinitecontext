import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgRoot = path.resolve(sdkRoot, "../../packages/sync-cursor/src/index.mjs");
const libPath = path.join(sdkRoot, "lib/sync-cursor.mjs");

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

describe("sync-cursor copies", () => {
  it("js-sdk lib matches packages/sync-cursor/src/index.mjs", () => {
    assert.equal(sha256File(libPath), sha256File(pkgRoot));
  });
});
