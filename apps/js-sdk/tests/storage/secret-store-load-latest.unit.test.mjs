import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, describe, it } from "node:test";

import {
  formatGenerationSecretsFileName,
  loadLatestSecretsMap,
} from "../../lib/storage/secret-store-file-generations.mjs";

describe("loadLatestSecretsMap generation ENOENT", () => {
  it("throws store_not_found after re-list when generation file stays missing", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-secret-store-missing-gen-unit-"));
    const kek = new Uint8Array(32);
    kek.fill(7);
    const genPath = path.join(rootDir, formatGenerationSecretsFileName(1));
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(genPath, "placeholder", { mode: 0o600 });

    const readMock = mock.method(fs, "readFileSync", (target, encoding) => {
      if (target === genPath) {
        const error = new Error("ENOENT");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
      return readMock.mock.original.call(fs, target, encoding);
    });

    try {
      assert.throws(
        () => loadLatestSecretsMap(rootDir, kek),
        (error) =>
          error instanceof Error && "code" in error && error.code === "store_not_found",
      );
    } finally {
      readMock.mock.restore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
