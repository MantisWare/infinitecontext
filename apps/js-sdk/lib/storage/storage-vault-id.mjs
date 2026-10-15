import { bytesToHex } from "@noble/hashes/utils";

import { computeDekProof } from "../ic-crypto.mjs";

/**
 * Stable vault identity for migration destination checks (same DEK ⇒ same vault).
 *
 * @param {Uint8Array} dek
 */
export function storageVaultIdFromDek(dek) {
  return bytesToHex(computeDekProof(dek));
}
