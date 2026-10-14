import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { randomBytes } from "../../lib/ic-crypto.mjs";
import { PreconditionFailedError } from "../../lib/storage/errors.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";
import {
  decryptVaultStorageObjectPlaintext,
  moveStorageObjectWithDek,
} from "../../lib/storage/storage-object-move.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "../../lib/storage/encrypt-storage-object.mjs";
import { verifyStorageObjectForKey } from "../../lib/storage/ciphertext.mjs";

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

  it("preserves dek_v3 and seq 7 and labels across move", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-move-v3-"));
    const dek = randomBytes(32);
    dek[0] = 3;
    const adapter = createFilesystemStorageAdapter({ rootDir });
    await adapter.init();

    const fromKey = "move/v3/from.enc";
    const toKey = "move/v3/to.enc";
    const payload = { labels: ["alpha", "beta"], note: "v3-seq7" };
    const body = copyVerifiedStoragePutBodyForAdapter(
      encryptVaultPlaintextForStoragePut(dek, fromKey, payload, { dekVersion: 3, seq: 7 }),
    );
    await adapter.put(fromKey, body, { ifNoneMatch: "*" });

    await moveStorageObjectWithDek(adapter, dek, fromKey, toKey, { dekVersion: 3, seq: 7 });

    const dest = await adapter.get(toKey);
    assert.ok(dest);
    const record = verifyStorageObjectForKey(dest.body, toKey);
    assert.equal(record.enc?.kid, "dek_v3");
    assert.match(String(record.aad), /\|7$/);
    const roundTrip = decryptVaultStorageObjectPlaintext(dek, toKey, dest.body);
    assert.deepEqual(roundTrip.labels, ["alpha", "beta"]);
    assert.equal(roundTrip.note, "v3-seq7");

    await adapter.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("throws partial_move with destination etag when source delete loses ifMatch", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-partial-move-"));
    const dek = randomBytes(32);
    dek[0] = 2;
    const inner = createFilesystemStorageAdapter({ rootDir });
    await inner.init();

    const fromKey = "move/partial/from.enc";
    const toKey = "move/partial/to.enc";
    const body = copyVerifiedStoragePutBodyForAdapter(
      encryptVaultPlaintextForStoragePut(dek, fromKey, { x: 1 }),
    );
    await inner.put(fromKey, body, { ifNoneMatch: "*" });

    /** @type {import("../../lib/storage/types.mjs").StorageAdapter} */
    const adapter = {
      init: () => inner.init(),
      close: () => inner.close(),
      get: (key, opts) => inner.get(key, opts),
      head: (key, opts) => inner.head(key, opts),
      put: (key, putBody, opts) => inner.put(key, putBody, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
      delete: async (key, opts) => {
        if (key === fromKey && opts?.ifMatch) {
          const live = await inner.get(fromKey);
          assert.ok(live);
          const replacement = copyVerifiedStoragePutBodyForAdapter(
            encryptVaultPlaintextForStoragePut(dek, fromKey, { x: 2 }),
          );
          await inner.put(fromKey, replacement, { ifMatch: live.etag });
        }
        return inner.delete(key, opts);
      },
    };

    await assert.rejects(
      () => moveStorageObjectWithDek(adapter, dek, fromKey, toKey),
      (error) => {
        assert.equal(error.code, "partial_move");
        assert.equal(error.sourceOutcome, "rewritten");
        assert.ok(typeof error.destinationEtag === "string" && error.destinationEtag.length > 0);
        return true;
      },
    );

    const dest = await inner.get(toKey);
    assert.ok(dest);
    assert.ok(await inner.get(fromKey));

    await inner.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("partial_move reports deleted when source disappears before cleanup", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-storage-partial-deleted-"));
    const dek = randomBytes(32);
    dek[0] = 4;
    const inner = createFilesystemStorageAdapter({ rootDir });
    await inner.init();

    const fromKey = "move/partial/gone.enc";
    const toKey = "move/partial/dest.enc";
    const body = copyVerifiedStoragePutBodyForAdapter(
      encryptVaultPlaintextForStoragePut(dek, fromKey, { v: 1 }),
    );
    await inner.put(fromKey, body, { ifNoneMatch: "*" });

    /** @type {import("../../lib/storage/types.mjs").StorageAdapter} */
    const adapter = {
      init: () => inner.init(),
      close: () => inner.close(),
      get: (key, opts) => inner.get(key, opts),
      head: (key, opts) => inner.head(key, opts),
      put: (key, putBody, opts) => inner.put(key, putBody, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
      delete: async (key, opts) => {
        if (key === fromKey) {
          await inner.delete(key);
          throw new PreconditionFailedError("ifMatch precondition failed");
        }
        return inner.delete(key, opts);
      },
    };

    await assert.rejects(
      () => moveStorageObjectWithDek(adapter, dek, fromKey, toKey),
      (error) => {
        assert.equal(error.code, "partial_move");
        assert.equal(error.sourceOutcome, "deleted");
        return true;
      },
    );

    await inner.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
