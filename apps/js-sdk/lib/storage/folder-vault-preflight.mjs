import { layoutRootPath, logSegmentRelativePath } from "./layout.mjs";
import { StorageError } from "./errors.mjs";
import { loadFolderMergedManifest } from "./storage-manifest-folder.mjs";

const REIMPORT_HINT =
  "Export a full vault backup and re-import into the folder sync root (logs must retain seq 0 after GC). " +
  "See docs/design/storage-layout.md § folder migration.";

/**
 * Refuse folder sync when any participating device log is missing genesis seq 0
 * (typical after local-backend GC before moving ciphertext into a synced folder).
 *
 * @param {import('./types.mjs').StorageAdapter} adapter
 * @param {Uint8Array} dek
 * @param {string} layoutPrefix
 */
export async function assertFolderVaultLogsBeginAtSeqZero(adapter, dek, layoutPrefix) {
  const manifest = await loadFolderMergedManifest(adapter, dek, layoutPrefix);
  const logRoot = `${layoutRootPath(layoutPrefix)}/log/`;
  /** @type {Set<string>} */
  const devHs = new Set();
  for (const row of manifest.devices) {
    if (row.last_seq >= 0) devHs.add(row.devH);
  }
  let cursor;
  for (;;) {
    const page = await adapter.list(logRoot, { limit: 500, cursor });
    for (const row of page.objects) {
      const m = /\/log\/([0-9A-HJKMNP-TV-Z]{26})\//i.exec(row.key);
      if (m) devHs.add(m[1].toUpperCase());
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  for (const devH of devHs) {
    const key = logSegmentRelativePath(layoutPrefix, devH, 0);
    const got = await adapter.get(key);
    if (!got?.body) {
      throw new StorageError(
        `Device log for ${devH} is missing genesis segment seq 0; folder sync cannot replay after local GC. ${REIMPORT_HINT}`,
        "invalid_argument",
      );
    }
  }
}
