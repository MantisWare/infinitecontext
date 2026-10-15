/** @typedef {{ kind: 'vector', v: Record<string, number> }} VectorSyncCursor */

/**
 * @param {unknown} raw
 * @returns {VectorSyncCursor}
 */
export function normalizeVectorSyncCursor(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.kind === "vector") {
    const v = raw.v && typeof raw.v === "object" && !Array.isArray(raw.v) ? raw.v : {};
    /** @type {Record<string, number>} */
    const cleaned = {};
    for (const [devH, seq] of Object.entries(v)) {
      const n = Number(seq);
      if (Number.isSafeInteger(n) && n >= 0) {
        cleaned[devH] = n;
      }
    }
    return { kind: "vector", v: cleaned };
  }
  const numeric = Number(raw ?? 0);
  if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric > 0) {
    return { kind: "vector", v: {}, _migrated_numeric: numeric };
  }
  return { kind: "vector", v: {} };
}

/** @param {unknown} raw @returns {number} */
export function normalizeHostedSyncSince(raw) {
  const n = Number(raw ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Sum of per-device last applied segment seq values (delete base / head_sequence). */
export function vectorCursorHeadSum(cursor) {
  if (!cursor || typeof cursor !== "object" || cursor.kind !== "vector") {
    return 0;
  }
  let sum = 0;
  for (const seq of Object.values(cursor.v ?? {})) {
    const n = Number(seq);
    if (Number.isSafeInteger(n) && n >= 0) sum += n;
  }
  return sum;
}

/**
 * @param {VectorSyncCursor} cursor
 * @param {string} devH canonical (uppercase) devH
 * @param {number} seq
 */
export function advanceVectorCursorDevH(cursor, devH, seq) {
  const prev = cursor.v[devH] ?? -1;
  if (seq > prev) {
    cursor.v[devH] = seq;
  }
}

/** Per-devH max of two vector cursors (monotonic compaction floor). */
export function maxVectorSyncCursor(a, b) {
  const left = normalizeVectorSyncCursor(a);
  const right = normalizeVectorSyncCursor(b);
  /** @type {Record<string, number>} */
  const v = { ...left.v };
  for (const [devH, seq] of Object.entries(right.v ?? {})) {
    const n = Number(seq);
    if (!Number.isSafeInteger(n) || n < 0) continue;
    v[devH] = Math.max(v[devH] ?? -1, n);
  }
  return { kind: "vector", v };
}

/** @param {VectorSyncCursor} cursor */
export function serializeVectorSyncCursor(cursor) {
  return JSON.stringify(cursor);
}

/** @param {string | number | null | undefined} stored */
export function parseStoredSyncCursor(stored) {
  if (stored === null || stored === undefined || stored === "") {
    return normalizeVectorSyncCursor(0);
  }
  if (typeof stored === "number") {
    return normalizeVectorSyncCursor(stored);
  }
  const text = String(stored).trim();
  if (text.startsWith("{")) {
    try {
      return normalizeVectorSyncCursor(JSON.parse(text));
    } catch {
      return normalizeVectorSyncCursor(0);
    }
  }
  return normalizeVectorSyncCursor(Number(text));
}
