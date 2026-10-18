#!/usr/bin/env node
/**
 * Race proof: first-get barrier + honest memory adapter.
 * Head: 0/20 double holds. Reverted double-get stale-break: 20/20 double holds.
 * Patches a temp copy of lib/storage — never mutates the repo lease-lock.mjs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sdkRoot, "../..");
const leasePath = path.join(sdkRoot, "lib/storage/lease-lock.mjs");
const runner = path.join(sdkRoot, "scripts/lease-race-proof-runner.mjs");
const preload = path.join(repoRoot, "scripts/ic-test-tmp-preload.mjs");

const RUNS = 20;

const SINGLE_GET_BLOCK = `  if (existing && isLeaseLockStale(existing, now) && row?.etag) {
    try {
      await options.adapter.delete(key, { ifMatch: row.etag });
    } catch {
      /* best-effort break stale */
    }
  }`;

const DOUBLE_GET_BLOCK = `  if (existing && isLeaseLockStale(existing, now)) {
    let etagForDelete = row?.etag;
    const row2 = await readLeaseObject(options.adapter, options.dek, options.layoutPrefix, lockName);
    etagForDelete = row2?.etag ?? etagForDelete;
    if (etagForDelete) {
      try {
        await options.adapter.delete(key, { ifMatch: etagForDelete });
      } catch {
        /* best-effort break stale */
      }
    }
  }`;

/**
 * @param {string | undefined} leaseModulePath
 */
function runCounter(leaseModulePath) {
  /** @type {Record<string, string>} */
  const env = { ...process.env, IC_LEASE_RACE_RUNS: String(RUNS) };
  if (leaseModulePath) {
    env.IC_LEASE_RACE_LEASE_MODULE = leaseModulePath;
  } else {
    delete env.IC_LEASE_RACE_LEASE_MODULE;
  }
  const res = spawnSync(process.execPath, ["--import", preload, runner], {
    cwd: sdkRoot,
    encoding: "utf8",
    env,
  });
  process.stdout.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
  const match = /IC_LEASE_RACE_DOUBLE_HOLDS=(\d+)/.exec(String(res.stdout));
  return match ? Number(match[1]) : NaN;
}

function createPatchedLeaseModuleCopy() {
  const patchRoot = fs.mkdtempSync(path.join(sdkRoot, ".tmp-lease-race-patch-"));
  const libCopy = path.join(patchRoot, "lib");
  const storageCopy = path.join(libCopy, "storage");
  fs.mkdirSync(storageCopy, { recursive: true });
  fs.cpSync(path.join(sdkRoot, "lib/storage"), storageCopy, { recursive: true });
  const icCryptoTarget = path.join(sdkRoot, "lib/ic-crypto.mjs");
  fs.symlinkSync(icCryptoTarget, path.join(libCopy, "ic-crypto.mjs"));
  const patchedLease = path.join(storageCopy, "lease-lock.mjs");
  const text = fs.readFileSync(patchedLease, "utf8");
  if (!text.includes(SINGLE_GET_BLOCK)) {
    throw new Error("lease-lock copy: single-get stale-break block not found");
  }
  fs.writeFileSync(patchedLease, text.replace(SINGLE_GET_BLOCK, DOUBLE_GET_BLOCK, 1));
  return { patchRoot, patchedLease };
}

console.log(`=== Head lease-lock (${RUNS} runs, first-get barrier, honest memory) ===`);
const headDouble = runCounter(undefined);
console.log(`head double-holds: ${headDouble}/${RUNS}`);

const { patchRoot, patchedLease } = createPatchedLeaseModuleCopy();
try {
  console.log(`\n=== Reverted double-get stale-break (${RUNS} runs, temp module copy) ===`);
  const revertedDouble = runCounter(patchedLease);
  console.log(`reverted double-holds: ${revertedDouble}/${RUNS}`);
  if (headDouble !== 0 || revertedDouble !== RUNS) {
    console.error(
      `proof FAILED: expected head 0/${RUNS} and reverted ${RUNS}/${RUNS}, got head ${headDouble}/${RUNS} reverted ${revertedDouble}/${RUNS}`,
    );
    process.exit(1);
  }
  console.log(`\nproof OK: head 0/${RUNS}, reverted ${RUNS}/${RUNS}`);
} finally {
  fs.rmSync(patchRoot, { recursive: true, force: true });
}
