/** @param {unknown} change */
export function isObjectStoreSyncChange(change) {
  if (!change || typeof change !== "object") return false;
  const hlc = /** @type {Record<string, unknown>} */ (change).hlc;
  return hlc !== null && hlc !== undefined && typeof hlc === "object";
}
