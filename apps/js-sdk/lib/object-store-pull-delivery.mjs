import {
  advanceVectorCursorDevH,
  normalizeVectorSyncCursor,
} from "./sync-cursor.mjs";
import { checkTrustedHeadAdvance } from "./object-store-local-sync-state.mjs";

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 */
export function capturePullApplyBaseline(state) {
  return {
    vectorCursor: normalizeVectorSyncCursor(state.vectorCursor),
    trustedHeads: structuredClone(state.trustedHeads ?? {}),
    ledger: structuredClone(state.ledger ?? []),
    changeOrdinal: state.changeOrdinal,
    localHlc: structuredClone(state.localHlc ?? { wall_ms: 0, counter: 0 }),
  };
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {ReturnType<typeof capturePullApplyBaseline>} baseline
 * @param {ReturnType<typeof capturePullApplyBaseline>} after
 */
export function stashPendingPullDeliveryApply(state, baseline, after) {
  state.pendingPullDeliveryApply = {
    vectorCursor: normalizeVectorSyncCursor(after.vectorCursor),
    trustedHeads: structuredClone(after.trustedHeads),
    ledger: structuredClone(after.ledger),
    changeOrdinal: after.changeOrdinal,
    localHlc: structuredClone(after.localHlc),
    baselineVectorCursor: baseline.vectorCursor,
  };
}

/**
 * @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state
 * @param {ReturnType<typeof capturePullApplyBaseline>} baseline
 */
export function restorePullApplyBaseline(state, baseline) {
  state.vectorCursor = normalizeVectorSyncCursor(baseline.vectorCursor);
  state.trustedHeads = structuredClone(baseline.trustedHeads);
  state.ledger = structuredClone(baseline.ledger);
  state.changeOrdinal = baseline.changeOrdinal;
  state.localHlc = structuredClone(baseline.localHlc);
}

/** @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state */
export function applyPendingPullDeliveryApply(state) {
  const pending = state.pendingPullDeliveryApply;
  if (!pending || typeof pending !== "object") return false;
  state.vectorCursor = normalizeVectorSyncCursor(pending.vectorCursor);
  for (const [devH, head] of Object.entries(pending.trustedHeads ?? {})) {
    if (!head || head.seq < 0) continue;
    const prev = state.trustedHeads[devH];
    if (!prev) {
      state.trustedHeads[devH] = { seq: head.seq, digest: head.digest };
      continue;
    }
    if (head.seq > prev.seq) {
      state.trustedHeads[devH] = { seq: head.seq, digest: head.digest };
    } else if (head.seq === prev.seq) {
      checkTrustedHeadAdvance(prev, head);
    }
  }
  state.ledger = Array.isArray(pending.ledger) ? structuredClone(pending.ledger) : state.ledger;
  state.changeOrdinal = Math.max(state.changeOrdinal, pending.changeOrdinal ?? 0);
  const prevHlc = state.localHlc ?? { wall_ms: 0, counter: 0 };
  const nextHlc = pending.localHlc ?? prevHlc;
  if (
    nextHlc.wall_ms > prevHlc.wall_ms ||
    (nextHlc.wall_ms === prevHlc.wall_ms && nextHlc.counter > prevHlc.counter)
  ) {
    state.localHlc = { ...nextHlc };
  }
  state.pendingPullDeliveryApply = null;
  return true;
}

/** @param {import('./object-store-local-sync-state.mjs').ObjectStoreLocalSyncState} state */
export function effectiveVectorCursorForPull(state) {
  const pending = state.pendingPullDeliveryApply;
  if (pending?.vectorCursor) return normalizeVectorSyncCursor(pending.vectorCursor);
  return normalizeVectorSyncCursor(state.vectorCursor);
}
