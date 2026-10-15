import { randomBytes } from "node:crypto";

import { sampleEncryptedObjectBytesForKey } from "./contract-suite.mjs";
import { PreconditionFailedError } from "./errors.mjs";

/**
 * Parallel If-None-Match:* creates on one key must not both succeed.
 *
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {{ rounds?: number }} [options]
 */
export async function probeCrossDeviceCasConcurrency(adapter, options = {}) {
  const rounds = options.rounds ?? 200;
  for (let i = 0; i < rounds; i += 1) {
    const probeKey = `ic-cas-race/${randomBytes(8).toString("hex")}.probe`;
    const body = sampleEncryptedObjectBytesForKey(probeKey);
    const results = await Promise.allSettled([
      adapter.put(probeKey, body, { ifNoneMatch: "*" }),
      adapter.put(probeKey, body, { ifNoneMatch: "*" }),
    ]);
    let successes = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        successes += 1;
        continue;
      }
      if (!(result.reason instanceof PreconditionFailedError)) {
        return false;
      }
    }
    if (successes > 1) {
      return false;
    }
    try {
      await adapter.delete(probeKey);
    } catch {
      /* best-effort */
    }
  }
  return true;
}
