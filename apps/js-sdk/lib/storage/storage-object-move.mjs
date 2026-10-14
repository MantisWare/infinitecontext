import { decryptAead } from "../ic-crypto.mjs";
import {
  copyVerifiedStoragePutBodyForAdapter,
  encryptVaultPlaintextForStoragePut,
} from "./encrypt-storage-object.mjs";
import { StorageError } from "./errors.mjs";
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
 * Client-side move: decrypt with DEK, re-encrypt for destination AAD, conditional put + delete.
 * @param {StorageAdapter} adapter
 * @param {Uint8Array} dek 32-byte storage DEK
 * @param {string} fromKey
 * @param {string} toKey
 */
export async function moveStorageObjectWithDek(adapter, dek, fromKey, toKey) {
  const src = await adapter.get(fromKey);
  if (!src) {
    throw new StorageError(`Source object missing (${fromKey})`, "not_found");
  }
  const plaintext = decryptVaultStorageObjectPlaintext(dek, fromKey, src.body);
  const sealed = encryptVaultPlaintextForStoragePut(dek, toKey, plaintext);
  const bodyForPut = copyVerifiedStoragePutBodyForAdapter(sealed);
  await adapter.put(toKey, bodyForPut, { ifNoneMatch: "*" });
  await adapter.delete(fromKey, { ifMatch: src.etag });
}
