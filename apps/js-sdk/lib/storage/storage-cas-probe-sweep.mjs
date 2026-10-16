export const CAS_PROBE_OBJECT_PREFIXES = ["ic-cas-probe/", "ic-cas-race/"];

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 */
export async function sweepStaleCasProbeObjects(adapter) {
  let removed = 0;
  for (const prefix of CAS_PROBE_OBJECT_PREFIXES) {
    let cursor;
    do {
      const page = await adapter.list(prefix, { limit: 500, cursor });
      for (const row of page.objects) {
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
