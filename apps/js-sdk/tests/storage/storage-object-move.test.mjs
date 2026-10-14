import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { randomBytes } from "../../lib/ic-crypto.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import {
  decryptVaultStorageObjectPlaintext,
  moveStorageObjectWithDek,
} from "../../lib/storage/storage-object-move.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";

describe("moveStorageObjectWithDek", () => {
  it("decrypts at destination after client-side move", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-move-"));
    const dek = randomBytes(32);
    dek[0] = 1;
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();

    const fromKey = "move/from.enc";
    const toKey = "move/to.enc";
    const payload = { hello: "world", n: 42 };
    const body = copyVerifiedStoragePutBodyForAdapter(
      encryptVaultPlaintextForStoragePut(dek, fromKey, payload),
    );
    await adapter.put(fromKey, body, { ifNoneMatch: "*" });

    await moveStorageObjectWithDek(adapter, dek, fromKey, toKey);

    assert.equal(await adapter.get(fromKey), null);
    const dest = await adapter.get(toKey);
    assert.ok(dest);
    const roundTrip = decryptVaultStorageObjectPlaintext(dek, toKey, dest.body);
    assert.deepEqual(roundTrip, payload);

    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
