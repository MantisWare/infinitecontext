/**
 * Detect desktop-sync conflict-copy filename patterns (iCloud, Dropbox, OneDrive).
 * Keys use lowercase segments; conflict variants apply to the final segment only.
 */

/**
 * @param {string} segment
 * @returns {string | null} canonical segment when `segment` is a conflict copy
 */
export function conflictSegmentToCanonical(segment) {
  const s = String(segment ?? "");
  if (!s) return null;

  const icloud = /^(.+?) (\d+)(\.[a-z0-9._-]+)$/i.exec(s);
  if (icloud) {
    return `${icloud[1]}${icloud[3]}`.toLowerCase();
  }

  const dropbox = /^(.+?) \([^)]*conflicted copy[^)]*\)(\.[a-z0-9._-]+)$/i.exec(s);
  if (dropbox) {
    return `${dropbox[1]}${dropbox[2]}`.toLowerCase();
  }

  const onedrive = /^(.+?) - [^/\\]+(\.[a-z0-9._-]+)$/i.exec(s);
  if (onedrive) {
    return `${onedrive[1]}${onedrive[2]}`.toLowerCase();
  }

  return null;
}

/**
 * @param {string} storageKey canonical lowercase key
 * @returns {string} canonical key (unchanged when not a conflict alias)
 */
export function canonicalizeConflictStorageKey(storageKey) {
  const key = String(storageKey ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!key) return key;
  const parts = key.split("/");
  const last = parts[parts.length - 1];
  const canonicalLast = conflictSegmentToCanonical(last);
  if (!canonicalLast) return key;
  parts[parts.length - 1] = canonicalLast;
  return parts.join("/");
}

/**
 * @param {string} fileName generation or leaf file name
 * @returns {{ canonicalName: string, isConflict: boolean }}
 */
export function canonicalizeConflictFileName(fileName) {
  const name = String(fileName ?? "");
  const canonical = conflictSegmentToCanonical(name);
  if (canonical) {
    return { canonicalName: canonical, isConflict: true };
  }
  return { canonicalName: name, isConflict: false };
}
