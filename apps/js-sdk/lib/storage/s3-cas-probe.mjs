import { randomBytes } from "node:crypto";

import { sampleEncryptedObjectBytesForKey } from "./contract-suite.mjs";
import { PreconditionFailedError } from "./errors.mjs";

/**
 * @param {import("./types.mjs").StorageAdapter} adapter
 */
export async function probeS3CrossDeviceCas(adapter) {
  const probeKey = `ic-s3-cas-probe/${randomBytes(8).toString("hex")}.probe`;
  const body = sampleEncryptedObjectBytesForKey(probeKey);
  try {
    const created = await adapter.put(probeKey, body, { ifNoneMatch: "*" });
    if (!created.etag) {
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
    try {
      await adapter.delete(probeKey);
    } catch {
      /* best-effort cleanup */
    }
    return true;
  } catch {
    return false;
  }
}
