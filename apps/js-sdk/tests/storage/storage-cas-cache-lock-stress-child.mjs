import fs from "node:fs";

import {
  markStorageCasUnsafePersisted,
  mutateStorageCasCache,
  recordStorageCasInitProbeSuccess,
  setStorageCasCacheRecord,
} from "../../lib/storage/storage-cas-cache.mjs";

const input = JSON.parse(fs.readFileSync(process.env.IC_CAS_STRESS_INPUT ?? "", "utf8"));
const { cachePath, mode, workerId, iterations, bindingKey } = input;

if (mode === "writes") {
  for (let i = 0; i < iterations; i += 1) {
    const key = `${bindingKey}:worker:${workerId}`;
    mutateStorageCasCache(cachePath, (cache) => {
      setStorageCasCacheRecord(cache, key, {
        bindingKey: key,
        crossDeviceCas: true,
        probedAtMs: i,
        expiresAtMs: Date.now() + 60_000,
      });
    });
  }
  process.exit(0);
}

if (mode === "flag-survival") {
  if (workerId === 0) {
    markStorageCasUnsafePersisted(cachePath, bindingKey, "race_double_win", Date.now());
    process.exit(0);
  }
  for (let i = 0; i < iterations; i += 1) {
    recordStorageCasInitProbeSuccess(cachePath, bindingKey, Date.now());
  }
  process.exit(0);
}

process.stderr.write(`unknown stress mode: ${mode}\n`);
process.exit(2);
