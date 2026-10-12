/** @param {string | undefined} raw */
export function isUpdateCheckDisabled(raw = process.env.INFINITECONTEXT_NO_UPDATE_CHECK) {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
