import { LayoutIntegrityError, decryptLogSegment, layoutSegmentEnvelopeDigest } from "./storage/layout.mjs";
import { ObjectStoreLogForkError, ObjectStoreLogRollbackError } from "./object-store-local-sync-state.mjs";

/**
 * @param {{ dek: Uint8Array }} ctx
 * @param {string} devH canonical
 * @param {{ seq: number, digest: string } | undefined} trustedHead
 * @param {(seq: number) => Promise<import('./ic-crypto.mjs').AeadEnvelope | null>} readEnvelopeAtSeq
 * @param {number} targetSeq
 */
export async function verifyDeviceLogThroughSeq(ctx, devH, trustedHead, readEnvelopeAtSeq, targetSeq) {
  if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) {
    throw new LayoutIntegrityError("targetSeq must be non-negative");
  }
  if (trustedHead && targetSeq < trustedHead.seq) {
    throw new ObjectStoreLogRollbackError(
      `Remote log for ${devH} rolled back (local seq ${trustedHead.seq}, remote ${targetSeq})`,
    );
  }

  let startSeq = 0;
  /** @type {string | null} */
  let expectedPrev = null;

  if (trustedHead) {
    const anchorEnv = await readEnvelopeAtSeq(trustedHead.seq);
    if (!anchorEnv) {
      throw new ObjectStoreLogRollbackError(
        `Remote log for ${devH} missing trusted segment at seq ${trustedHead.seq}`,
      );
    }
    const anchorDigest = layoutSegmentEnvelopeDigest(anchorEnv);
    if (anchorDigest !== trustedHead.digest) {
      throw new ObjectStoreLogForkError(`Remote log fork at ${devH} seq ${trustedHead.seq}`);
    }
    decryptLogSegment(ctx.dek, devH, trustedHead.seq, anchorEnv);
    startSeq = trustedHead.seq + 1;
    expectedPrev = anchorDigest;
  }

  for (let seq = startSeq; seq <= targetSeq; seq += 1) {
    const envelope = await readEnvelopeAtSeq(seq);
    if (!envelope) {
      throw new ObjectStoreLogRollbackError(`Remote log for ${devH} missing segment at seq ${seq}`);
    }
    const record = decryptLogSegment(ctx.dek, devH, seq, envelope);
    if (expectedPrev === null) {
      if (record.seq !== 0 || record.prev_digest !== "") {
        throw new LayoutIntegrityError("Genesis segment must have seq 0 and empty prev_digest");
      }
    } else if (record.prev_digest !== expectedPrev) {
      throw new ObjectStoreLogForkError(`Log segment prev_digest mismatch at ${devH} seq ${seq}`);
    }
    expectedPrev = layoutSegmentEnvelopeDigest(envelope);
  }
}

/**
 * @param {{ dek: Uint8Array }} ctx
 * @param {string} devH
 * @param {{ seq: number, digest: string } | undefined} trustedHead
 * @param {(seq: number) => Promise<import('./ic-crypto.mjs').AeadEnvelope | null>} readEnvelopeAtSeq
 * @param {{ seq: number, digest: string }} candidateHead
 */
export async function assertOwnPrefixHeadChainsFromTrust(ctx, devH, trustedHead, readEnvelopeAtSeq, candidateHead) {
  if (trustedHead && candidateHead.seq < trustedHead.seq) {
    throw new ObjectStoreLogRollbackError(
      `Own log prefix rolled back (trusted seq ${trustedHead.seq}, remote ${candidateHead.seq})`,
    );
  }
  if (trustedHead && candidateHead.seq === trustedHead.seq) {
    if (candidateHead.digest !== trustedHead.digest) {
      throw new ObjectStoreLogForkError(`Own log fork at ${devH} seq ${trustedHead.seq}`);
    }
    return;
  }
  await verifyDeviceLogThroughSeq(ctx, devH, trustedHead, readEnvelopeAtSeq, candidateHead.seq);
  const env = await readEnvelopeAtSeq(candidateHead.seq);
  if (!env || layoutSegmentEnvelopeDigest(env) !== candidateHead.digest) {
    throw new ObjectStoreLogForkError(`Own log head digest mismatch at ${devH} seq ${candidateHead.seq}`);
  }
}
