export const CAS_PROBE_OBJECT_PREFIXES = ["ic-cas-probe/", "ic-cas-race/"];
export const CAS_PROBE_SWEEP_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 * @param {{ maxAgeMs?: number, nowMs?: number }} [options]
 */
export async function sweepStaleCasProbeObjects(adapter, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? CAS_PROBE_SWEEP_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  let removed = 0;
  for (const prefix of CAS_PROBE_OBJECT_PREFIXES) {
    let cursor;
    do {
      const page = await adapter.list(prefix, { limit: 500, cursor });
      for (const row of page.objects) {
        const modifiedMs = row.modifiedAt ? Date.parse(row.modifiedAt) : NaN;
        if (Number.isFinite(modifiedMs) && nowMs - modifiedMs < maxAgeMs) {
          continue;
        }
        try {
          await adapter.delete(row.key);
          removed += 1;
        } catch {
          /* best-effort */
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return removed;
}
