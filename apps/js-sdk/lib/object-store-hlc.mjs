import { canonicalDevH } from "./storage/layout.mjs";

/** @typedef {{ wall_ms: number, counter: number, devH: string }} HlcTuple */

/**
 * @param {HlcTuple} a
 * @param {HlcTuple} b
 * @returns {number} negative if a < b
 */
export function compareHlc(a, b) {
  if (a.wall_ms !== b.wall_ms) return a.wall_ms - b.wall_ms;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.devH.localeCompare(b.devH);
}

/**
 * @param {unknown} raw
 * @param {string} devH canonical
 * @returns {HlcTuple | null}
 */
export function parseMutationHlc(raw, devH) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const wall = Number(raw.wall_ms);
    const counter = Number(raw.counter);
    const d = raw.devH ? canonicalDevH(String(raw.devH)) : canonicalDevH(devH);
    if (Number.isSafeInteger(wall) && wall >= 0 && Number.isSafeInteger(counter) && counter >= 0) {
      return { wall_ms: wall, counter, devH: d };
    }
  }
  return null;
}

/**
 * Legacy ISO#index strings (migration / tests only).
 * @param {string} raw
 * @param {string} devH
 * @param {number} index
 */
export function hlcFromLegacyString(raw, devH, index) {
  const text = String(raw ?? "");
  const hashIdx = text.lastIndexOf("#");
  const iso = hashIdx >= 0 ? text.slice(0, hashIdx) : text;
  const parsed = Date.parse(iso);
  const wall_ms = Number.isFinite(parsed) ? parsed : 0;
  const counter = hashIdx >= 0 ? Number(text.slice(hashIdx + 1)) : Number(index);
  return {
    wall_ms,
    counter: Number.isSafeInteger(counter) && counter >= 0 ? counter : index,
    devH: canonicalDevH(devH),
  };
}

/**
 * @param {unknown} raw
 * @param {string} devH
 * @param {number} index
 */
export function normalizeMutationHlc(raw, devH, index) {
  const parsed = parseMutationHlc(raw, devH);
  if (parsed) return parsed;
  if (typeof raw === "string") return hlcFromLegacyString(raw, devH, index);
  return { wall_ms: Date.now(), counter: index, devH: canonicalDevH(devH) };
}

/** @param {HlcTuple} hlc */
export function serializeMutationHlc(hlc) {
  return { wall_ms: hlc.wall_ms, counter: hlc.counter, devH: canonicalDevH(hlc.devH) };
}

/**
 * @param {{ localHlc?: { wall_ms: number, counter: number } }} state
 * @param {string} selfDevH
 * @returns {HlcTuple}
 */
export function nextLocalMutationHlc(state, selfDevH) {
  const now = Date.now();
  const prev = state.localHlc ?? { wall_ms: 0, counter: 0 };
  let wall_ms = Math.max(now, prev.wall_ms);
  let counter = 0;
  if (wall_ms === prev.wall_ms) {
    counter = prev.counter + 1;
  }
  state.localHlc = { wall_ms, counter };
  return { wall_ms, counter, devH: canonicalDevH(selfDevH) };
}

/**
 * Advance local HLC clock from remote observations (on pull).
 * @param {{ localHlc?: { wall_ms: number, counter: number } }} state
 * @param {HlcTuple} remote
 */
export function observeRemoteHlc(state, remote) {
  const prev = state.localHlc ?? { wall_ms: 0, counter: 0 };
  if (remote.wall_ms > prev.wall_ms) {
    state.localHlc = { wall_ms: remote.wall_ms, counter: remote.counter };
    return;
  }
  if (remote.wall_ms === prev.wall_ms && remote.counter > prev.counter) {
    state.localHlc = { wall_ms: prev.wall_ms, counter: remote.counter };
  }
}
