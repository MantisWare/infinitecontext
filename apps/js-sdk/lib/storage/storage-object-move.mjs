import { decryptAead, parseDekVersion } from "../ic-crypto.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "./encrypt-storage-object.mjs";
import { PreconditionFailedError, StorageError } from "./errors.mjs";
import { verifyStorageObjectForKey } from "./ciphertext.mjs";

/** @typedef {import("./types.mjs").StorageAdapter} StorageAdapter */

/**
 * @param {Uint8Array} dek
 * @param {string} objectKey
 * @param {Uint8Array} body
 */
export function decryptVaultStorageObjectPlaintext(dek, objectKey, body) {
  const record = verifyStorageObjectForKey(body, objectKey);
  const enc = record.enc;
  if (!enc || typeof enc !== "object") {
    throw new StorageError("Storage object missing enc envelope", "corrupt_storage");
  }
  const aadBytes = new TextEncoder().encode(String(record.aad));
  const plaintext = decryptAead(dek, /** @type {import("../ic-crypto.mjs").AeadEnvelope} */ (enc), aadBytes);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * @param {number} dekVersion
 * @param {string} kid
 */
function assertDekVersionMatchesKid(dekVersion, kid) {
  const expectedKid = `dek_v${dekVersion}`;
  if (kid !== expectedKid) {
    throw new StorageError(
      `Storage DEK version ${dekVersion} does not match object kid ${kid}`,
      "invalid_argument",
    );
  }
}

/**
 * @param {string} aad
 */
function seqFromStorageAad(aad) {
  const seqPart = String(aad).split("|").pop();
  const seq = Number(seqPart);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new StorageError("Storage object aad has invalid seq", "corrupt_storage");
  }
  return seq;
}

/**
 * Client-side move: decrypt with DEK, re-encrypt for destination AAD, conditional put + delete.
 * @param {StorageAdapter} adapter
 * @param {Uint8Array} dek 32-byte storage DEK
 * @param {string} fromKey
 * @param {string} toKey
 * @param {{ kid?: string, seq?: number, dekVersion?: number }} [options]
 */
export async function moveStorageObjectWithDek(adapter, dek, fromKey, toKey, options = {}) {
  const src = await adapter.get(fromKey);
  if (!src) {
    throw new StorageError(`Source object missing (${fromKey})`, "not_found");
  }
  const record = verifyStorageObjectForKey(src.body, fromKey);
  const enc = record.enc;
  if (!enc || typeof enc !== "object" || typeof enc.kid !== "string") {
    throw new StorageError("Storage object missing enc envelope", "corrupt_storage");
  }
  const sourceKid = enc.kid;
  const sourceSeq = seqFromStorageAad(String(record.aad));
  const sourceDekVersion = parseDekVersion(sourceKid);

  if (options.kid !== undefined && options.kid !== sourceKid) {
    throw new StorageError("moveStorageObjectWithDek kid does not match source object", "invalid_argument");
  }
  if (options.seq !== undefined && options.seq !== sourceSeq) {
    throw new StorageError("moveStorageObjectWithDek seq does not match source object", "invalid_argument");
  }
  if (options.dekVersion !== undefined && options.dekVersion !== sourceDekVersion) {
    throw new StorageError(
      "moveStorageObjectWithDek dekVersion does not match source object",
      "invalid_argument",
    );
  }

  const dekVersion = options.dekVersion ?? sourceDekVersion;
  const kid = options.kid ?? sourceKid;
  const seq = options.seq ?? sourceSeq;
  assertDekVersionMatchesKid(dekVersion, kid);

  const plaintext = decryptVaultStorageObjectPlaintext(dek, fromKey, src.body);
  const sealed = encryptVaultPlaintextForStoragePut(dek, toKey, plaintext, { dekVersion, seq });
  const bodyForPut = copyVerifiedStoragePutBodyForAdapter(sealed);
  const destPut = await adapter.put(toKey, bodyForPut, { ifNoneMatch: "*" });
  try {
    await adapter.delete(fromKey, { ifMatch: src.etag });
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      const destHead = await adapter.head(toKey);
      const destinationEtag = destPut.etag ?? destHead?.etag;
      const sourceStillLive = await adapter.head(fromKey);
      /** @type {'rewritten' | 'deleted'} */
      const sourceOutcome = sourceStillLive ? "rewritten" : "deleted";
      const partial = new StorageError(
        sourceOutcome === "deleted"
          ? "Storage object copied to destination but source was deleted before cleanup"
          : "Storage object copied to destination but source was rewritten before cleanup",
        "partial_move",
      );
      partial.destinationEtag = destinationEtag;
      partial.sourceOutcome = sourceOutcome;
      throw partial;
    }
    throw error;
  }
}
