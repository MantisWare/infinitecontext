import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  FS_GEN_SUFFIX,
  FS_TEMP_PREFIX,
  FS_TEMP_SWEEP_MAX_AGE_MS,
  isFilesystemTempArtifact,
} from "../../lib/storage/filesystem-object-file.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

describe("filesystem temp sweep", () => {
  it("matches generation crash temp names and sweeps stale files", async () => {
    assert.equal(isFilesystemTempArtifact(`${FS_TEMP_PREFIX}000000000001${FS_GEN_SUFFIX}.tmp.1`), true);
    assert.equal(isFilesystemTempArtifact(`000000000001${FS_GEN_SUFFIX}.tmp.9`), true);

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-fs-temp-sweep-"));
    const staleDir = path.join(rootDir, "objects", "demo", "obj.enc");
    fs.mkdirSync(staleDir, { recursive: true });
    const stalePath = path.join(
      staleDir,
      `${FS_TEMP_PREFIX}000000000001${FS_GEN_SUFFIX}.tmp.${process.pid}.old`,
    );
    fs.writeFileSync(stalePath, "stale", { mode: 0o600 });
    const stale = new Date(Date.now() - FS_TEMP_SWEEP_MAX_AGE_MS - 5_000);
    fs.utimesSync(stalePath, stale, stale);

    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();
    assert.equal(fs.existsSync(stalePath), false);
    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
