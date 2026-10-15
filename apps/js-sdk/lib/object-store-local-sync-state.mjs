import {
  advanceVectorCursorDevH,
  normalizeVectorSyncCursor,
  vectorCursorHeadSum,
} from "./sync-cursor.mjs";

/** @typedef {import('./sync-cursor.mjs').VectorSyncCursor} VectorSyncCursor */

/**
 * @typedef {Object} ObjectStoreLocalSyncState
 * @property {number} selfNextSeq next seq to attempt for this device log
 * @property {Record<string, { seq: number, digest: string }>} trustedHeads canonical uppercase devH
 * @property {VectorSyncCursor} vectorCursor
 * @property {object[]} ledger local merged ledger for delete stale checks
 * @property {object[]} conflicts
 * @property {number} changeOrdinal monotonic hosted-shaped sequence for emitted changes
 * @property {{ wall_ms: number, counter: number }} localHlc hybrid logical clock for local stamps
 * @property {string} [logListCursor] pagination cursor for discovering remote log prefixes
 * @property {number} [appliedSnapshotEpoch] snapshot epoch hydrated on this device (-1 = none)
 * @property {Record<string, unknown>} [pendingBootstrapReplica] sanitized replica pending pull delivery
 * @property {boolean} [bootstrapReplicaPendingAck] bootstrap delivered to client but manifest ack deferred
 * @property {import('./sync-cursor.mjs').VectorSyncCursor} [snapshotCompactedThrough] floor covered by applied snapshot
 * @property {number} [manifestGenerationHighWater] last trusted manifest generation seen locally
 * @property {string} [storageBindingKey] backend id + root path for manifest high-water rebinding
 * @property {number} [verifiedManifestGeneration] manifest generation bound to appliedSnapshotEpoch + snapshot floor
 * @property {object} [pendingPullDeliveryApply] deferred cursor/trust until confirmPullDelivery
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
    localHlc: { wall_ms: 0, counter: 0 },
    logListCursor: "",
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
  return computeHeadSequenceFromTrustedHeads(state);
}

/**
 * @param {{ seq: number, digest: string } | undefined} prev
 * @param {{ seq: number, digest: string }} nextHead
 */
export function checkTrustedHeadAdvance(prev, nextHead) {
  if (!prev) return;
  if (nextHead.seq < prev.seq) {
    throw new ObjectStoreLogRollbackError(
      `Remote log for device rolled back (local seq ${prev.seq}, remote ${nextHead.seq})`,
    );
  }
  if (nextHead.seq === prev.seq && nextHead.digest !== prev.digest) {
    throw new ObjectStoreLogForkError(`Remote log fork at seq ${nextHead.seq}`);
  }
}

/**
 * @param {ObjectStoreLocalSyncState} state
 * @param {string} devH canonical
 * @param {{ seq: number, digest: string }} nextHead
 */
export function commitTrustedHeadAdvance(state, devH, nextHead) {
  const prev = state.trustedHeads[devH];
  checkTrustedHeadAdvance(prev, nextHead);
  if (!prev || nextHead.seq > prev.seq || nextHead.digest !== prev.digest) {
    state.trustedHeads[devH] = { seq: nextHead.seq, digest: nextHead.digest };
  }
}

/** @param {ObjectStoreLocalSyncState} state @param {string} devH @param {{ seq: number, digest: string }} nextHead */
export function assertTrustedHeadAdvance(state, devH, nextHead) {
  commitTrustedHeadAdvance(state, devH, nextHead);
}

/**
 * Persist trusted heads only when moving forward (for atomic save backends).
 * @param {ObjectStoreLocalSyncState} persisted
 * @param {ObjectStoreLocalSyncState} incoming
 */
export function mergeTrustedHeadsForwardOnly(persisted, incoming) {
  for (const [devH, head] of Object.entries(incoming.trustedHeads ?? {})) {
    if (!head) continue;
    const prev = persisted.trustedHeads[devH];
    if (!prev) {
      persisted.trustedHeads[devH] = { ...head };
      continue;
    }
    if (head.seq > prev.seq) {
      persisted.trustedHeads[devH] = { seq: head.seq, digest: head.digest };
    } else if (head.seq === prev.seq && head.digest === prev.digest) {
      persisted.trustedHeads[devH] = { seq: prev.seq, digest: prev.digest };
    }
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

export class ObjectStoreLogMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ObjectStoreLogMissingError";
    this.code = "log_missing";
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
