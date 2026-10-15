import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} left
 * @param {string} right
 */
function normalizePathForComparison(left, right) {
  let aReal;
  let bReal;
  try {
    aReal = fs.realpathSync(path.resolve(left));
    bReal = fs.realpathSync(path.resolve(right));
  } catch {
    return { comparable: false, equal: false };
  }
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  if (caseInsensitive) {
    return { comparable: true, equal: aReal.toLowerCase() === bReal.toLowerCase() };
  }
  return { comparable: true, equal: aReal === bReal };
}

/**
 * @param {string} left
 * @param {string} right
 */
export function storagePathsReferToSameLocation(left, right) {
  const result = normalizePathForComparison(left, right);
  return result.comparable && result.equal;
}

/**
 * When realpath cannot resolve either path (refuse destructive ops that depend on sameness).
 *
 * @param {string} left
 * @param {string} right
 */
export function storagePathsReferToSameLocationOrUnresolvable(left, right) {
  const result = normalizePathForComparison(left, right);
  if (!result.comparable) {
    return true;
  }
  return result.equal;
}
