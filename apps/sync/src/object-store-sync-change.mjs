/** @param {unknown} change */
export function isObjectStoreSyncChange(change) {
  if (!change || typeof change !== "object") return false;
  const row = /** @type {Record<string, unknown>} */ (change);
  const hlc = row.hlc;
  if (hlc === null || hlc === undefined || typeof hlc !== "object") return false;
  const devH = row.source_dev_h;
  return typeof devH === "string" && devH.length > 0;
}
