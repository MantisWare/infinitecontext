import { randomBytes } from "node:crypto";

import { sampleEncryptedObjectBytesForKey, sampleEncryptedObjectBytesVariant } from "./contract-suite.mjs";
import { PreconditionFailedError } from "./errors.mjs";

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {{ rounds?: number }} [options]
 */
export async function probeCrossDeviceCasRace(adapter, options = {}) {
  const rounds = options.rounds ?? 20;
  for (let i = 0; i < rounds; i += 1) {
    const createKey = `ic-cas-race/inm-${randomBytes(8).toString("hex")}.probe`;
    const replaceKey = `ic-cas-race/match-${randomBytes(8).toString("hex")}.probe`;
    const bodyA = sampleEncryptedObjectBytesForKey(createKey);
    const bodyB = sampleEncryptedObjectBytesVariant(createKey, 0xa1);
    try {
      const createResults = await Promise.allSettled([
        adapter.put(createKey, bodyA, { ifNoneMatch: "*" }),
        adapter.put(createKey, bodyB, { ifNoneMatch: "*" }),
      ]);
      let createSuccesses = 0;
      for (const result of createResults) {
        if (result.status === "fulfilled") {
          createSuccesses += 1;
          continue;
        }
        if (!(result.reason instanceof PreconditionFailedError)) {
          return { ok: false, phase: "inm_create", round: i, detail: "unexpected_error" };
        }
      }
      if (createSuccesses > 1) {
        return { ok: false, phase: "inm_create", round: i, detail: "double_win" };
      }

      const seedBody = sampleEncryptedObjectBytesForKey(replaceKey);
      const created = await adapter.put(replaceKey, seedBody, { ifNoneMatch: "*" });
      if (!created.etag) {
        return { ok: false, phase: "if_match_setup", round: i, detail: "missing_etag" };
      }
      const replaceA = sampleEncryptedObjectBytesVariant(replaceKey, 0xb1);
      const replaceB = sampleEncryptedObjectBytesVariant(replaceKey, 0xb2);
      const replaceResults = await Promise.allSettled([
        adapter.put(replaceKey, replaceA, { ifMatch: created.etag }),
        adapter.put(replaceKey, replaceB, { ifMatch: created.etag }),
      ]);
      let replaceSuccesses = 0;
      for (const result of replaceResults) {
        if (result.status === "fulfilled") {
          replaceSuccesses += 1;
          continue;
        }
        if (!(result.reason instanceof PreconditionFailedError)) {
          return { ok: false, phase: "if_match_replace", round: i, detail: "unexpected_error" };
        }
      }
      if (replaceSuccesses > 1) {
        return { ok: false, phase: "if_match_replace", round: i, detail: "double_win" };
      }
    } finally {
      for (const key of [createKey, replaceKey]) {
        try {
          await adapter.delete(key);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { ok: true, rounds };
}
