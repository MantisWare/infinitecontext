import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";

import {
  markStorageCasUnsafePersisted,
  recordStorageCasDoctorRecheckSuccess,
  recordStorageCasDoctorRaceSuccess,
  loadStorageCasCache,
  setStorageCasClockForTests,
} from "../../lib/storage/storage-cas-cache.mjs";

describe("storage CAS clock skew (A2)", () => {
  afterEach(() => {
    setStorageCasClockForTests(null);
  });

  it("new unsafe mark stays above doctor passes when wall clock jumps backward", () => {
    let fakeNow = 1_000_000;
    setStorageCasClockForTests(() => fakeNow);

    const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ic-cas-clock-")), "cache.json");
    const bindingKey = "s3:test:bucket:p";

    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win");
    recordStorageCasDoctorRecheckSuccess(cachePath, bindingKey);
    recordStorageCasDoctorRaceSuccess(cachePath, bindingKey);

    const before = loadStorageCasCache(cachePath).endpoints[bindingKey];
    const latestPass = Math.max(before?.seqRecheckAtMs ?? 0, before?.racePassAtMs ?? 0);
    assert.ok(latestPass >= fakeNow);

    fakeNow = 500;
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win");

    const after = loadStorageCasCache(cachePath).endpoints[bindingKey];
    assert.ok((after?.unsafeAtMs ?? 0) >= latestPass + 1);
    assert.equal(after?.seqRecheckAtMs ?? 0, 0);
    assert.equal(after?.casUnsafe, true);
  });
});
