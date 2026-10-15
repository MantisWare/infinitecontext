/**
 * @param {string} canonicalKey
 */
export function conflictResolutionHintForStorageKey(canonicalKey) {
  const logMatch = /\/log\/([0-9A-HJKMNP-TV-Z]{26})\/(\d{12})\.enc$/i.exec(canonicalKey);
  if (logMatch) {
    const devH = logMatch[1].toUpperCase();
    const seq = Number(logMatch[2]);
    return (
      `Resolve manually: keep exactly one sync copy for device ${devH} log seq ${seq} ` +
      `(delete or quarantine the other copy folder / .icgen file on the owning machine). ` +
      `Do not run repair until you choose copy A or copy B.`
    );
  }
  const devMatch = /\/devices\/([0-9A-HJKMNP-TV-Z]{26})\.json\.enc$/i.exec(canonicalKey);
  if (devMatch) {
    const devH = devMatch[1].toUpperCase();
    return (
      `Resolve manually: keep exactly one sync copy for devices/${devH}.json.enc ` +
      `(delete or quarantine the other copy on the owning device). ` +
      `Do not run repair until you choose copy A or copy B.`
    );
  }
  return (
    "Resolve manually: keep exactly one sync copy for this object (delete or quarantine the other copy). " +
    "Do not run repair until you choose copy A or copy B."
  );
}
