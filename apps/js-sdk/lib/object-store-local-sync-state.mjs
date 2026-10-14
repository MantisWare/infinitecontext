import {
  advanceVectorCursorDevH,
  normalizeVectorSyncCursor,
  vectorCursorHeadSum,
} from "@infinitecontext/sync-cursor";

/** @typedef {import('@infinitecontext/sync-cursor').VectorSyncCursor} VectorSyncCursor */

/**
 * @typedef {Object} ObjectStoreLocalSyncState
 * @property {number} selfNextSeq next seq to attempt for this device log
 * @property {Record<string, { seq: number, digest: string }>} trustedHeads canonical uppercase devH
 * @property {VectorSyncCursor} vectorCursor
 * @property {object[]} ledger local merged ledger for delete stale checks
 * @property {object[]} conflicts
 * @property {number} changeOrdinal monotonic hosted-shaped sequence for emitted changes
 */

/** @returns {ObjectStoreLocalSyncState} */
export function createEmptyObjectStoreLocalSyncState() {
  return {
    selfNextSeq: 0,
    trustedHeads: {},
    vectorCursor: normalizeVectorSyncCursor(0),
    ledger: [],
    conflicts: [],
    changeOrdinal: 0,
  };
}

/** @param {ObjectStoreLocalSyncState} state */
export function computeHeadSequenceFromTrustedHeads(state) {
  let sum = 0;
  for (const head of Object.values(state.trustedHeads)) {
    if (head && Number.isSafeInteger(head.seq) && head.seq >= 0) {
      sum += head.seq;
    }
  }
  return sum;
}

/** @param {ObjectStoreLocalSyncState} state */
export function headSequenceForStatus(state) {
  return vectorCursorHeadSum(state.vectorCursor);
}

/**
 * @param {ObjectStoreLocalSyncState} state
 * @param {string} devH canonical
 * @param {{ seq: number, digest: string }} nextHead
 */
export function assertTrustedHeadAdvance(state, devH, nextHead) {
  const prev = state.trustedHeads[devH];
  if (!prev) {
    state.trustedHeads[devH] = { seq: nextHead.seq, digest: nextHead.digest };
    return;
  }
  if (nextHead.seq < prev.seq) {
    throw new ObjectStoreLogRollbackError(
      `Remote log for ${devH} rolled back (local seq ${prev.seq}, remote ${nextHead.seq})`,
    );
  }
  if (nextHead.seq === prev.seq && nextHead.digest !== prev.digest) {
    throw new ObjectStoreLogForkError(`Remote log fork at ${devH} seq ${nextHead.seq}`);
  }
  if (nextHead.seq > prev.seq) {
    state.trustedHeads[devH] = { seq: nextHead.seq, digest: nextHead.digest };
  }
}

export class ObjectStoreLogRollbackError extends Error {
  constructor(message) {
    super(message);
    this.name = "ObjectStoreLogRollbackError";
    this.code = "log_rollback";
  }
}

export class ObjectStoreLogForkError extends Error {
  constructor(message) {
    super(message);
    this.name = "ObjectStoreLogForkError";
    this.code = "log_fork";
  }
}

/** @param {Partial<ObjectStoreLocalSyncState>} [seed] */
export function createInMemoryObjectStoreLocalState(seed = {}) {
  /** @type {ObjectStoreLocalSyncState} */
  let state = { ...createEmptyObjectStoreLocalSyncState(), ...seed };
  return {
    load() {
      return structuredClone(state);
    },
    save(next) {
      state = structuredClone(next);
    },
  };
}

export { advanceVectorCursorDevH, vectorCursorHeadSum };
