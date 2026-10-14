import fs from "node:fs";
import path from "node:path";

import { assertHardLinkCommitSupported } from "./secret-store-file-link.mjs";
import { PreconditionFailedError, StorageError } from "./errors.mjs";
import { assertCanonicalStorageObjectKey } from "./filesystem-keys.mjs";
import {
  computeObjectEtag,
  encodeObjectFile,
  fsyncDirectory,
  FS_GEN_HIGH_WATER_BASENAME,
  FS_GEN_SUFFIX,
  FS_TEMP_PREFIX,
  readObjectFileNoFollow,
  writeExclusiveTempFile,
} from "./filesystem-object-file.mjs";
import { mapFsError, rejectSymlinkPath } from "./filesystem-paths.mjs";

const GEN_PAD = 12;
const MAX_GENERATION = 999_999_999_999;
const MAX_CAS_ATTEMPTS = 64;
const OBJECTS_SUBDIR = "objects";

/** Default age before tombstone-only keys (never recreated) are swept on init. */
export const TOMBSTONE_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {number} */
let tombstoneSweepMaxAgeMs = Number(
  process.env.IC_FS_OBJECT_TEST_TOMBSTONE_SWEEP_MAX_AGE_MS || TOMBSTONE_SWEEP_MAX_AGE_MS,
);

/** @param {number} ms */
export function setFilesystemTombstoneSweepMaxAgeMsForTests(ms) {
  tombstoneSweepMaxAgeMs = ms;
}

/** @type {number} */
let testStallBeforeLinkMs = Number(process.env.IC_FS_OBJECT_TEST_STALL_BEFORE_LINK_MS || 0);

/** @param {number} ms */
export function setFilesystemObjectTestStallBeforeLinkMsForTests(ms) {
  testStallBeforeLinkMs = ms;
}

/** @type {number} */
let testSweepPauseAfterMarkerMs = Number(
  process.env.IC_FS_OBJECT_TEST_SWEEP_PAUSE_AFTER_MARKER_MS || 0,
);

/** @param {number} ms */
export function setFilesystemTombstoneSweepPauseAfterMarkerMsForTests(ms) {
  testSweepPauseAfterMarkerMs = ms;
}

/** @param {number} gen */
export function formatObjectGenerationFileName(gen) {
  if (!Number.isSafeInteger(gen) || gen <= 0 || gen > MAX_GENERATION) {
    throw new StorageError("Storage object generation out of range", "not_supported");
  }
  return `${String(gen).padStart(GEN_PAD, "0")}${FS_GEN_SUFFIX}`;
}

/** @param {string} name */
export function parseGenerationFromObjectFileName(name) {
  if (!name.endsWith(FS_GEN_SUFFIX)) {
    return null;
  }
  const middle = name.slice(0, -FS_GEN_SUFFIX.length);
  if (!/^\d+$/.test(middle)) {
    return null;
  }
  const gen = Number(middle);
  return Number.isSafeInteger(gen) && gen > 0 ? gen : null;
}

/**
 * @param {string} rootDir
 * @param {string} key
 */
export function objectKeyDirectory(rootDir, key) {
  const canonical = assertCanonicalStorageObjectKey(key);
  const root = path.resolve(rootDir);
  const objectsRoot = path.join(root, OBJECTS_SUBDIR);
  rejectSymlinkPath(objectsRoot);
  let cursor = objectsRoot;
  for (const segment of canonical.split("/")) {
    cursor = path.join(cursor, segment);
    rejectSymlinkPath(cursor);
  }
  return {
    canonical,
    keyDir: cursor,
    objectsRoot,
  };
}

/**
 * @param {string} keyDir
 * @returns {{ gen: number, path: string }[]}
 */
/**
 * @param {string} keyDir
 * @returns {number} 0 when no marker (legacy keys)
 */
export function readGenerationHighWater(keyDir) {
  const markerPath = path.join(keyDir, FS_GEN_HIGH_WATER_BASENAME);
  let text;
  try {
    text = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw mapFsError(error, markerPath);
  }
  try {
    const parsed = JSON.parse(text);
    const gen = Number(parsed?.high_water);
    if (!Number.isSafeInteger(gen) || gen <= 0) {
      throw new StorageError("Corrupt generation high-water marker", "corrupt_storage");
    }
    return gen;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("Corrupt generation high-water marker", "corrupt_storage");
  }
}

/**
 * @param {string} keyDir
 * @param {number} highWater
 * @returns {{ gen: number, path: string }[]}
 */
function listNonStaleGenerationPaths(keyDir, highWater) {
  const paths = listGenerationPathsForKeyDir(keyDir);
  if (highWater <= 0) {
    return paths;
  }
  return paths.filter((row) => row.gen >= highWater);
}

/**
 * @param {string} rootDir
 * @param {string} keyDir
 * @param {number} gen
 * @returns {number} persisted high-water generation
 */
export function writeGenerationHighWater(rootDir, keyDir, gen) {
  if (!Number.isSafeInteger(gen) || gen <= 0) {
    throw new StorageError("Generation high-water out of range", "invalid_argument");
  }
  let existing = 0;
  try {
    existing = readGenerationHighWater(keyDir);
  } catch (error) {
    if (!(error instanceof StorageError && error.code === "corrupt_storage")) {
      throw error;
    }
    existing = 0;
  }
  const target = existing > 0 ? Math.max(existing, gen) : gen;
  if (existing === target && existing > 0) {
    return target;
  }
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const markerPath = path.join(keyDir, FS_GEN_HIGH_WATER_BASENAME);
  const payload = `${JSON.stringify({ high_water: target })}\n`;
  const tmpPath = path.join(
    keyDir,
    `${FS_TEMP_PREFIX}high-water.tmp.${process.pid}.${Date.now()}`,
  );
  writeExclusiveTempFile(tmpPath, new TextEncoder().encode(payload), rootDir);
  fs.renameSync(tmpPath, markerPath);
  try {
    fs.chmodSync(markerPath, 0o600);
  } catch {
    // best effort
  }
  fsyncDirectory(keyDir);
  return target;
}

export function listGenerationPathsForKeyDir(keyDir) {
  /** @type {{ gen: number, path: string }[]} */
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(keyDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return found;
    }
    throw mapFsError(error, keyDir);
  }
  for (const name of entries) {
    const gen = parseGenerationFromObjectFileName(name);
    if (gen === null) {
      continue;
    }
    const fullPath = path.join(keyDir, name);
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) {
        continue;
      }
    } catch {
      continue;
    }
    found.push({ gen, path: fullPath });
  }
  found.sort((a, b) => b.gen - a.gen);
  return found;
}

/**
 * @param {string} rootDir
 * @param {string} key
 * @param {boolean} [retriedAfterRelist]
 * @returns {{ gen: number, header: import("./filesystem-object-file.mjs").StoredObjectHeader, body: Uint8Array } | null}
 */
export function loadLatestObjectGeneration(rootDir, key, retriedAfterRelist = false) {
  const { canonical, keyDir } = objectKeyDirectory(rootDir, key);
  const highWater = readGenerationHighWater(keyDir);
  const paths = listNonStaleGenerationPaths(keyDir, highWater);
  if (paths.length === 0) {
    return null;
  }
  const highest = paths[0];
  try {
    const decoded = readObjectFileNoFollow(highest.path, canonical, rootDir);
    if (!decoded) {
      if (!retriedAfterRelist) {
        return loadLatestObjectGeneration(rootDir, key, true);
      }
      throw new StorageError(`Storage object generation missing at ${highest.path}`, "not_found");
    }
    return { gen: highest.gen, header: decoded.header, body: decoded.body };
  } catch (error) {
    if (
      !retriedAfterRelist &&
      error instanceof StorageError &&
      (error.code === "not_found" || error.code === "corrupt_storage")
    ) {
      return loadLatestObjectGeneration(rootDir, key, true);
    }
    if (error instanceof StorageError && error.code === "corrupt_storage") {
      throw error;
    }
    throw new StorageError(
      `Could not load storage object generation at ${highest.path}`,
      "corrupt_storage",
    );
  }
}

/**
 * @param {string} rootDir
 * @param {() => void} assertHeld
 * @param {string} key
 * @param {(state: { gen: number, header: import("./filesystem-object-file.mjs").StoredObjectHeader | null, body: Uint8Array | null }) => { header: import("./filesystem-object-file.mjs").StoredObjectHeader, body: Uint8Array }} buildNext
 */
export function commitObjectGenerationCas(rootDir, assertHeld, key, buildNext) {
  assertHardLinkCommitSupported(rootDir);
  const { canonical, keyDir } = objectKeyDirectory(rootDir, key);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    try {
      assertHeld();
    } catch (error) {
      if (error instanceof StorageError && error.code === "lock_compromised") {
        throw new StorageError("Lost storage object lock during CAS commit; retry the operation", "store_retry");
      }
      throw error;
    }

    const latest = loadLatestObjectGeneration(rootDir, canonical);
    const highWater = readGenerationHighWater(keyDir);
    const currentGen = Math.max(latest?.gen ?? 0, highWater);
    const nextGen = currentGen + 1;
    formatObjectGenerationFileName(nextGen);

    const built = buildNext({
      gen: currentGen,
      header: latest?.header ?? null,
      body: latest?.body ?? null,
    });

    const payload = encodeObjectFile(built.header, built.body);
    const nextName = formatObjectGenerationFileName(nextGen);
    const tmpPath = path.join(
      keyDir,
      `${FS_TEMP_PREFIX}${nextName}.tmp.${process.pid}.${Date.now()}.${attempt}`,
    );
    rejectSymlinkPath(tmpPath);
    writeExclusiveTempFile(tmpPath, payload, rootDir);

    try {
      assertHeld();
    } catch (error) {
      if (!(error instanceof StorageError && error.code === "lock_compromised")) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        throw error;
      }
    }

    if (testStallBeforeLinkMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testStallBeforeLinkMs);
    }

    const highWaterBeforeLink = readGenerationHighWater(keyDir);
    if (highWaterBeforeLink > 0 && nextGen <= highWaterBeforeLink) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw new PreconditionFailedError("Storage generation superseded by high-water marker");
    }

    const nextPath = path.join(keyDir, nextName);
    rejectSymlinkPath(nextPath);
    try {
      fs.linkSync(tmpPath, nextPath);
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        if (fs.existsSync(nextPath)) {
          try {
            readObjectFileNoFollow(nextPath, canonical, rootDir);
          } catch (readError) {
            if (readError instanceof StorageError && readError.code === "corrupt_storage") {
              throw readError;
            }
            throw new StorageError(
              `Corrupt storage object generation at ${nextPath}`,
              "corrupt_storage",
            );
          }
        }
        continue;
      }
      throw mapFsError(error, nextPath);
    }

    fsyncDirectory(keyDir);
    writeGenerationHighWater(rootDir, keyDir, nextGen);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    pruneOldGenerations(rootDir, keyDir, nextGen, built.header, canonical);
    return { gen: nextGen, header: built.header, body: built.body };
  }
  throw new StorageError("Storage object CAS commit exceeded retry limit", "store_retry");
}

/**
 * @param {string} rootDir
 * @param {string} keyDir
 * @param {number} committedGen
 * @param {import("./filesystem-object-file.mjs").StoredObjectHeader} committedHeader
 * @param {string} canonicalKey
 */
function pruneOldGenerations(rootDir, keyDir, committedGen, committedHeader, canonicalKey) {
  const tombstoneCommit = committedHeader.tombstone === true;
  /** Generations at or above this index are kept (retention window = last 2 live commits). */
  const keepFrom = tombstoneCommit ? committedGen : committedGen - 2;
  let removedAny = false;
  for (const row of listGenerationPathsForKeyDir(keyDir)) {
    if (row.gen >= keepFrom) {
      continue;
    }
    try {
      fs.unlinkSync(row.path);
      removedAny = true;
    } catch {
      // ignore
    }
  }
  if (!tombstoneCommit) {
    const retentionFloor = committedGen - 1;
    for (const row of listGenerationPathsForKeyDir(keyDir)) {
      if (row.gen >= retentionFloor) {
        continue;
      }
      try {
        const decoded = readObjectFileNoFollow(row.path, canonicalKey, rootDir);
        if (!decoded?.header.tombstone) {
          continue;
        }
      } catch {
        continue;
      }
      try {
        fs.unlinkSync(row.path);
        removedAny = true;
      } catch {
        // ignore
      }
    }
  }
  if (removedAny) {
    removeEmptyKeyDirectories(rootDir, keyDir);
  }
}

/**
 * @param {string} rootDir
 * @param {string} keyDir
 */
function removeEmptyKeyDirectories(rootDir, keyDir) {
  const objectsRoot = path.join(path.resolve(rootDir), OBJECTS_SUBDIR);
  let cursor = keyDir;
  while (cursor.startsWith(objectsRoot) && cursor !== objectsRoot) {
    let entries;
    try {
      entries = fs.readdirSync(cursor);
    } catch {
      break;
    }
    const nonMarkerEntries = entries.filter((name) => name !== FS_GEN_HIGH_WATER_BASENAME);
    if (nonMarkerEntries.length > 0) {
      break;
    }
    try {
      fs.rmdirSync(cursor);
    } catch {
      break;
    }
    cursor = path.dirname(cursor);
  }
}

/**
 * Remove stale tombstone-only keys while preserving generation high-water (never regress gen).
 * @param {string} rootDir
 * @param {() => void} [assertHeld]
 */
export function sweepStaleTombstoneOnlyKeys(rootDir, assertHeld = () => {}) {
  const now = Date.now();
  for (const key of listAllObjectKeys(rootDir)) {
    /** @type {{ gen: number, header: import("./filesystem-object-file.mjs").StoredObjectHeader } | null} */
    let latest;
    try {
      latest = loadLatestObjectGeneration(rootDir, key);
    } catch (error) {
      if (error instanceof StorageError && error.code === "corrupt_storage") {
        continue;
      }
      throw error;
    }
    if (!latest?.header.tombstone) {
      continue;
    }
    const { keyDir } = objectKeyDirectory(rootDir, key);
    const tombPath = path.join(keyDir, formatObjectGenerationFileName(latest.gen));
    let ageMs;
    try {
      ageMs = fs.statSync(tombPath).mtimeMs;
    } catch {
      continue;
    }
    if (now - ageMs < tombstoneSweepMaxAgeMs) {
      continue;
    }
    try {
      assertHeld();
    } catch (error) {
      if (error instanceof StorageError && error.code === "lock_compromised") {
        throw new StorageError("Lost storage object lock during tombstone sweep", "store_retry");
      }
      throw error;
    }
    let recheck;
    try {
      recheck = loadLatestObjectGeneration(rootDir, key);
    } catch (error) {
      if (error instanceof StorageError && error.code === "corrupt_storage") {
        continue;
      }
      throw error;
    }
    if (!recheck?.header.tombstone) {
      continue;
    }
    const recheckPath = path.join(keyDir, formatObjectGenerationFileName(recheck.gen));
    let recheckAgeMs;
    try {
      recheckAgeMs = fs.statSync(recheckPath).mtimeMs;
    } catch {
      continue;
    }
    if (now - recheckAgeMs < tombstoneSweepMaxAgeMs) {
      continue;
    }
    const tombGen = recheck.gen;
    writeGenerationHighWater(rootDir, keyDir, tombGen);
    if (testSweepPauseAfterMarkerMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testSweepPauseAfterMarkerMs);
    }
    for (const row of listGenerationPathsForKeyDir(keyDir)) {
      if (row.gen >= tombGen) {
        continue;
      }
      try {
        fs.unlinkSync(row.path);
      } catch {
        // ignore
      }
    }
  }
}

/** @param {string} rootDir */
export function listAllObjectKeys(rootDir) {
  const objectsRoot = path.join(path.resolve(rootDir), OBJECTS_SUBDIR);
  /** @type {string[]} */
  const keys = [];
  if (!fs.existsSync(objectsRoot)) {
    return keys;
  }
  /** @param {string} dir @param {string[]} segments */
  const walk = (dir, segments) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGen = entries.some(
      (entry) => entry.isFile() && parseGenerationFromObjectFileName(entry.name) !== null,
    );
    if (hasGen && segments.length > 0) {
      keys.push(segments.join("/"));
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      }
    }
  };
  walk(objectsRoot, []);
  return keys;
}

/**
 * @param {string} rootDir
 * @param {string} key
 * @param {number} gen
 */
export function removeCorruptObjectGenerationIfInvalid(rootDir, key, gen) {
  const { canonical, keyDir } = objectKeyDirectory(rootDir, key);
  const filePath = path.join(keyDir, formatObjectGenerationFileName(gen));
  try {
    readObjectFileNoFollow(filePath, canonical, rootDir);
    throw new StorageError(
      `Storage object generation ${gen} at ${filePath} is valid; refusing removal`,
      "invalid_argument",
    );
  } catch (error) {
    if (error instanceof StorageError && error.code === "invalid_argument") {
      throw error;
    }
    if (!(error instanceof StorageError && error.code === "corrupt_storage")) {
      throw error;
    }
  }
  try {
    fs.unlinkSync(filePath);
  } catch (unlinkError) {
    throw mapFsError(unlinkError, filePath);
  }
  removeEmptyKeyDirectories(rootDir, keyDir);
}

/**
 * @param {string} key
 * @param {Uint8Array} body
 * @param {number} revision
 */
export function buildLiveObjectHeader(key, body, revision) {
  const modifiedAt = new Date().toISOString();
  const etag = computeObjectEtag(key, body, revision);
  return {
    header: { etag, revision, size: body.length, modifiedAt, tombstone: false },
    body,
  };
}

/**
 * @param {number} revision
 */
export function buildTombstoneHeader(revision) {
  const modifiedAt = new Date().toISOString();
  return {
    header: {
      etag: `"tomb-${revision}"`,
      revision,
      size: 0,
      modifiedAt,
      tombstone: true,
    },
    body: new Uint8Array(0),
  };
}
