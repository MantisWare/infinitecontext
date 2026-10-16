import { randomBytes } from "node:crypto";

import { sampleEncryptedObjectBytesForKey } from "./contract-suite.mjs";
import { PreconditionFailedError } from "./errors.mjs";

/**
 * Verify the adapter honours S3-style conditional writes (If-Match / If-None-Match).
 * @param {import("./types.mjs").StorageAdapter} adapter
 */
export async function probeCrossDeviceCas(adapter) {
  const probeKey = `ic-cas-probe/${randomBytes(8).toString("hex")}.probe`;
  const body = sampleEncryptedObjectBytesForKey(probeKey);
  try {
    const created = await adapter.put(probeKey, body, { ifNoneMatch: "*" });
    if (!created.etag) {
      return false;
    }
    let rejectedInmOnExisting = false;
    try {
      await adapter.put(probeKey, body, { ifNoneMatch: "*" });
    } catch (error) {
      rejectedInmOnExisting = error instanceof PreconditionFailedError;
    }
    if (!rejectedInmOnExisting) {
      return false;
    }
    await adapter.put(probeKey, body, { ifMatch: created.etag });
    let rejectedWrongMatch = false;
    try {
      await adapter.put(probeKey, body, { ifMatch: '"00000000000000000000000000000000-0"' });
    } catch (error) {
      rejectedWrongMatch = error instanceof PreconditionFailedError;
    }
    if (!rejectedWrongMatch) {
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      await adapter.delete(probeKey);
    } catch {
      /* best-effort cleanup even when probe fails */
    }
  }
}
