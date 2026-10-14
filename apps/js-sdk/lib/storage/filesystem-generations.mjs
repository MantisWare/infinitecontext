import fs from "node:fs";
import path from "node:path";

import { assertHardLinkCommitSupported } from "./secret-store-file-link.mjs";
import { StorageError } from "./errors.mjs";
import { assertCanonicalStorageObjectKey } from "./filesystem-keys.mjs";
import {
  computeObjectEtag,
  encodeObjectFile,
  fsyncDirectory,
  FS_GEN_SUFFIX,
  readObjectFileNoFollow,
  writeExclusiveTempFile,
} from "./filesystem-object-file.mjs";
import { mapFsError, rejectSymlinkPath } from "./filesystem-paths.mjs";

const GEN_PAD = 12;
const MAX_GENERATION = 999_999_999_999;
const MAX_CAS_ATTEMPTS = 64;
const OBJECTS_SUBDIR = "objects";

/** @type {number} */
let testStallBeforeLinkMs = Number(process.env.IC_FS_OBJECT_TEST_STALL_BEFORE_LINK_MS || 0);

/** @param {number} ms */
export function setFilesystemObjectTestStallBeforeLinkMsForTests(ms) {
  testStallBeforeLinkMs = ms;
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
  };
}

/**
 * @param {string} keyDir
 * @returns {{ gen: number, path: string }[]}
 */
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
 * @returns {{ gen: number, header: import("./filesystem-object-file.mjs").StoredObjectHeader, body: Uint8Array } | null}
 */
export function loadLatestObjectGeneration(rootDir, key) {
  const { canonical, keyDir } = objectKeyDirectory(rootDir, key);
  const paths = listGenerationPathsForKeyDir(keyDir);
  if (paths.length === 0) {
    return null;
  }
  const highest = paths[0];
  try {
    const decoded = readObjectFileNoFollow(highest.path, canonical, rootDir);
    if (!decoded) {
      throw new StorageError(`Storage object generation missing at ${highest.path}`, "not_found");
    }
    return { gen: highest.gen, header: decoded.header, body: decoded.body };
  } catch (error) {
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
    const currentGen = latest?.gen ?? 0;
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
      `.${nextName}.tmp.${process.pid}.${Date.now()}.${attempt}`,
    );
    rejectSymlinkPath(tmpPath);
    writeExclusiveTempFile(tmpPath, payload);

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
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    pruneOldGenerations(keyDir, nextGen);
    return { gen: nextGen, header: built.header, body: built.body };
  }
  throw new StorageError("Storage object CAS commit exceeded retry limit", "store_retry");
}

/** @param {string} keyDir @param {number} committedGen */
function pruneOldGenerations(keyDir, committedGen) {
  const keepFrom = committedGen - 2;
  for (const row of listGenerationPathsForKeyDir(keyDir)) {
    if (row.gen < keepFrom) {
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
 * Remove corrupt generations for a key (manual repair helper).
 * @param {string} rootDir
 * @param {string} key
 * @param {number} gen
 */
export function removeObjectGenerationForRepair(rootDir, key, gen) {
  const { keyDir } = objectKeyDirectory(rootDir, key);
  const filePath = path.join(keyDir, formatObjectGenerationFileName(gen));
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    throw mapFsError(error, filePath);
  }
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
